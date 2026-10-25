import type { TeamConfig } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { REPO, teamConfig } from "../intake/test-support.js";
import { harness, SAM, type Harness } from "./test-support.js";

// The switches under `policies` that turn preset workflow rules off: the behaviour does not happen.

const dana = { kind: "human", id: "dana" } as const;
const sam = { kind: "agent", id: "sam" } as const;

const team = (policies: Record<string, unknown>): TeamConfig =>
  teamConfig({
    humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "dana", chat: "U-dana" } }],
    policies,
  });

let h: Harness;
afterEach(() => h.close());

const ticket = async (status: "active" | "review") => {
  const issue = await h.tracker.createIssue({
    title: "Search",
    body: "",
    status,
    assignee: "u-sam",
    labels: [],
  });

  await h.ws.apply(
    { type: "ticket.created", subject: { ticket: issue.key }, actor: dana, data: {} },
    { source: "tracker", externalId: `c-${issue.key}`, trusted: true },
  );

  return issue.key;
};

const status = async (key: string) => (await h.tracker.getIssue(key)).status.canonical;
const assignee = async (key: string) => (await h.tracker.getIssue(key)).assignee?.name;

describe("policies.conflicts.follow_up", () => {
  const afterMerge = async (policies: Record<string, unknown>) => {
    h = await harness({ team: team(policies) });
    await h.human("Dana");
    const a = await ticket("active");
    const b = await ticket("review");
    const prA = await h.vcs.seed.pullRequest(REPO, {
      title: "A",
      head: { ref: `sam/${a.toLowerCase()}` },
      author: { login: SAM, kind: "agent" },
    });

    await h.vcs.seed.pullRequest(REPO, {
      title: "B",
      head: { ref: `sam/${b.toLowerCase()}` },
      author: { login: SAM, kind: "agent" },
      mergeable: ["clean", "conflicting"],
    });

    await h.poll();
    await h.vcs.seed.merge(REPO, prA.number, "dana");
    await h.poll();
    return { a, b };
  };

  it("on (default): the conflicting pull request goes back to its author", async () => {
    const { b } = await afterMerge({});
    expect((await h.items("sam")).map((i) => i.kind)).toEqual(["conflict"]);
    expect(await status(b)).toBe("active");
  });

  it("off: nothing is scheduled, commented or moved", async () => {
    const { b } = await afterMerge({ conflicts: { follow_up: false } });
    expect(await h.items("sam")).toEqual([]);
    expect(await h.tracker.listComments(b)).toEqual([]);
    expect(await status(b)).toBe("review");
  });
});

describe("policies.feedback.merged_prs", () => {
  const mergedComment = async (policies: Record<string, unknown>) => {
    h = await harness({ team: team(policies) });
    await h.human("Dana");
    const pr = await h.vcs.seed.pullRequest(REPO, {
      title: "Add search",
      head: { ref: "sam/search" },
      author: { login: SAM, kind: "agent" },
    });

    await h.poll();
    await h.vcs.seed.merge(REPO, pr.number, "dana");
    await h.poll();
    await h.vcs.seed.comment(REPO, pr.number, "dana", "The flag name is wrong.");
    await h.poll();
  };

  it("on (default): schedules merged_feedback", async () => {
    await mergedComment({});
    expect((await h.items("sam")).map((i) => i.kind)).toEqual(["merged_feedback"]);
  });

  it("off: a comment on a merged pull request schedules nothing", async () => {
    await mergedComment({ feedback: { merged_prs: false } });
    expect(await h.items("sam")).toEqual([]);
  });
});

describe("policies.hand_back", () => {
  const handBack = async (policies: Record<string, unknown>) => {
    h = await harness({ team: team(policies) });
    await h.human("Dana");
    const key = await ticket("active");
    await h.deliver({
      type: "agent.handed_back",
      subject: { ticket: key },
      actor: sam,
      data: { status: "done" },
    });

    return key;
  };

  it("reassign: requester (default) moves the ticket to review and assigns the requester", async () => {
    const key = await handBack({});
    expect(await status(key)).toBe("review");
    expect(await assignee(key)).toBe("Dana");
  });

  it("reassign: none still moves the ticket to review but leaves the assignee", async () => {
    const key = await handBack({ hand_back: { reassign: "none" } });
    expect(await status(key)).toBe("review");
    expect(await assignee(key)).toBe("Sam");
  });
});
