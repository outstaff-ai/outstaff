import type { TeamConfig } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { REPO, teamConfig } from "../intake/test-support.js";
import { harness, SAM, type Harness } from "./test-support.js";

// policies.tickets.prs_per_ticket: the comment on a second pull request a person opens, and when a ticket is done.

const dana = { kind: "human", id: "dana" } as const;
const sam = { kind: "agent", id: "sam" } as const;

const team = (policies: Record<string, unknown> = {}): TeamConfig =>
  teamConfig({
    humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "dana", chat: "U-dana" } }],
    policies,
  });

let h: Harness;
afterEach(() => h.close());

const start = async (policies: Record<string, unknown> = {}) => {
  h = await harness({ team: team(policies) });
  await h.human("Dana");
  const issue = await h.tracker.createIssue({
    title: "Search",
    body: "",
    status: "active",
    assignee: "u-sam",
    labels: [],
  });

  await h.ws.apply(
    { type: "ticket.created", subject: { ticket: issue.key }, actor: dana, data: {} },
    { source: "tracker", externalId: `c-${issue.key}`, trusted: true },
  );

  return issue.key;
};

const open = async (key: string, part: string, author: "agent" | "human" = "agent") => {
  const pr = await h.vcs.seed.pullRequest(REPO, {
    title: `${key}: ${part}`,
    head: { ref: `${author === "agent" ? "sam" : "dana"}/${key.toLowerCase()}-${part}` },
    author: author === "agent" ? { login: SAM, kind: "agent" } : { login: "dana", kind: "human" },
  });

  await h.poll();
  return pr.number;
};

const merge = async (number: number) => {
  await h.vcs.seed.merge(REPO, number, "dana");
  await h.poll();
};

const status = async (key: string) => (await h.tracker.getIssue(key)).status.canonical;
const comments = async (key: string) => (await h.tracker.listComments(key)).map((c) => c.body);

/** The agent's work on the ticket ended as a hand-back as done: the item is done and the event is delivered. */
const handBack = async (key: string) => {
  const item = await h.scheduler.enqueue({
    person: "sam",
    kind: "assigned",
    title: `assigned: ${key}`,
    trigger: "human",
    priority: 100,
    subject: { type: "ticket", ref: key },
  });

  await h.store.updateItem(item.id, { status: "done" });
  await h.ws.refreshWorkers();
  await h.deliver({
    type: "agent.handed_back",
    subject: { ticket: key },
    actor: sam,
    data: { status: "done" },
  });
};

describe("a second pull request a person opens", () => {
  it("gets a comment on the ticket naming both and saying which merge closes it", async () => {
    const key = await start();
    const first = await open(key, "index");
    expect(await comments(key)).toEqual([]);

    const second = await open(key, "ui", "human");
    const [comment, ...rest] = await comments(key);
    expect(rest).toEqual([]);
    expect(comment).toContain(`${key} now has 2 pull requests`);
    expect(comment).toContain(`#${first} `);
    expect(comment).toContain(`#${second} `);
    expect(comment).toContain("merges first closes");
  });

  it("says what closes the ticket when the team allows several", async () => {
    const key = await start({ tickets: { prs_per_ticket: "many", start_moves_active: true } });
    await open(key, "index");
    await open(key, "ui", "human");
    expect((await comments(key))[0]).toContain("handed its work back as done");
  });

  it("is not commented on when an agent opens it, or when it is the first", async () => {
    const key = await start();
    await open(key, "index", "human");
    expect(await comments(key)).toEqual([]);

    const other = await start();
    await open(other, "index");
    await open(other, "ui");
    expect(await comments(other)).toEqual([]);
  });
});

describe("when a ticket with two pull requests is done", () => {
  it("with one (default), the first merge closes it", async () => {
    const key = await start();
    const first = await open(key, "index");
    await open(key, "ui");
    expect(await status(key)).toBe("review");
    await merge(first);
    expect(await status(key)).toBe("done");
  });

  it("with many, a merge alone does not close it", async () => {
    const key = await start({ tickets: { prs_per_ticket: "many", start_moves_active: true } });
    const first = await open(key, "index");
    await open(key, "ui");
    await merge(first);
    expect(await status(key)).toBe("review");
  });

  it("with many, the hand-back as done after every pull request merged closes it", async () => {
    const key = await start({ tickets: { prs_per_ticket: "many", start_moves_active: true } });
    const first = await open(key, "index");
    const second = await open(key, "ui");
    await merge(first);
    await merge(second);
    expect(await status(key)).toBe("review");
    await handBack(key);
    expect(await status(key)).toBe("done");
  });

  it("with many, the last merge after the hand-back as done closes it", async () => {
    const key = await start({ tickets: { prs_per_ticket: "many", start_moves_active: true } });
    const first = await open(key, "index");
    const second = await open(key, "ui");
    await handBack(key);
    // The hand-back does what it always does while a pull request is open: the requester reviews.
    expect(await status(key)).toBe("review");
    await merge(first);
    expect(await status(key)).toBe("review");
    await merge(second);
    expect(await status(key)).toBe("done");
  });

  it("with many, a pull request closed unmerged after the others merged still closes it", async () => {
    const key = await start({ tickets: { prs_per_ticket: "many", start_moves_active: true } });
    const first = await open(key, "index");
    const second = await open(key, "ui");
    await handBack(key);
    await merge(first);
    await h.vcs.seed.close(REPO, second, "dana");
    await h.poll();
    expect(await status(key)).toBe("done");
  });
});
