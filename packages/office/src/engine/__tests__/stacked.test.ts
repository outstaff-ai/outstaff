import type { TeamConfig, WorkflowEvent } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { REPO, teamConfig } from "#/intake/__tests__/test-support.js";
import { readFeedback } from "#/engine/feedback.js";
import { harness, SAM, type Harness } from "./test-support.js";

// Stacked pull requests and blocked retries: a merge into another pull request's branch is not the ticket's end, a
// conflict on an open pull request always goes back to its author, and a ticket that is still blocked stays blocked.

const dana = { kind: "human", id: "dana" } as const;
const sam = { kind: "agent", id: "sam" } as const;

const people = [
  {
    handle: "sam",
    name: "Sam",
    role: "developer",
    identities: { vcs: "acme-sam[bot]", tracker: "u-sam" },
  },
  { handle: "pat", name: "Pat", role: "pm", identities: { tracker: "u-pat" } },
];

const team = (): TeamConfig =>
  teamConfig({
    humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "dana", chat: "U-dana" } }],
    people,
  });

let h: Harness;
afterEach(() => h.close());

const ticket = async (status: "active" | "review" | "blocked" = "active") => {
  h = await harness({ team: team() });
  await h.human("Dana");
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

const open = async (
  key: string,
  part: string,
  over: { base?: string; mergeable?: ("clean" | "conflicting")[] } = {},
) => {
  const pr = await h.vcs.seed.pullRequest(REPO, {
    title: `${key}: ${part}`,
    head: { ref: `sam/${key.toLowerCase()}-${part}` },
    ...(over.base ? { base: { ref: over.base } } : {}),
    ...(over.mergeable ? { mergeable: over.mergeable } : {}),
    author: { login: SAM, kind: "agent" },
  });

  await h.poll();
  return pr.number;
};

const merge = async (number: number) => {
  await h.vcs.seed.merge(REPO, number, "dana");
  await h.poll();
};

describe("a stack of pull requests for one ticket", () => {
  it("stays in review while pull requests are open, schedules a conflict for the author, and is done with the last merge", async () => {
    const key = await ticket();
    const lower = await open(key, "a");
    const middle = await open(key, "b", { base: `sam/${key.toLowerCase()}-a` });
    const top = await open(key, "c", { mergeable: ["clean", "conflicting"] });
    expect(await status(key)).toBe("review");

    // The middle one merges into the lower one's branch.
    await merge(middle);

    // The ticket is not done. The conflict on the next open pull request goes to its author, with nobody asking,
    // and the ticket is active while that work runs.
    const items = await h.items("sam");
    expect(items.map((i) => [i.kind, i.subject?.ref])).toEqual([
      ["conflict", `git.acme.example/acme/app#${top}`],
    ]);

    expect(await status(key)).toBe("active");
    await h.tracker.transition(key, "review");
    await h.ws.apply(
      { type: "ticket.moved", subject: { ticket: key }, actor: sam, data: { to: "review" } },
      { source: "tracker", externalId: "mv-review", trusted: true },
    );

    // The lower one merges into the default branch, but the top one is still open.
    await merge(lower);
    expect(await status(key)).toBe("review");

    await merge(top);
    expect(await status(key)).toBe("done");
  });

  it("a conflict on an open pull request is scheduled even when the ticket was closed early", async () => {
    const key = await ticket("review");
    const other = await open(key, "a");
    const top = await open(key, "c", { mergeable: ["clean", "conflicting"] });
    await h.tracker.transition(key, "done");
    await h.ws.apply(
      { type: "ticket.moved", subject: { ticket: key }, actor: sam, data: { to: "done" } },
      { source: "tracker", externalId: "mv-done", trusted: true },
    );

    await merge(other);
    expect((await h.items("sam")).map((i) => i.kind)).toEqual(["conflict"]);
    expect(await status(key)).toBe("active");
    expect(top).toBeGreaterThan(0);
  });

  it("a comment on an open pull request of a ticket closed early reopens the ticket", async () => {
    const key = await ticket("review");
    const pr = await open(key, "a");
    await h.tracker.transition(key, "done");
    await h.ws.apply(
      { type: "ticket.moved", subject: { ticket: key }, actor: sam, data: { to: "done" } },
      { source: "tracker", externalId: "mv-done", trusted: true },
    );

    await h.vcs.seed.comment(REPO, pr, "dana", "Please rename the flag.");
    await h.poll();
    expect((await h.items("sam")).map((i) => i.kind)).toEqual(["review_feedback"]);
    expect(await status(key)).toBe("active");
  });

  it("work that starts on an open pull request reopens a ticket closed early", async () => {
    const key = await ticket("review");
    const pr = await open(key, "a");
    await h.tracker.transition(key, "done");
    await h.ws.apply(
      { type: "ticket.moved", subject: { ticket: key }, actor: sam, data: { to: "done" } },
      { source: "tracker", externalId: "mv-done", trusted: true },
    );

    const item = await h.scheduler.enqueue({
      person: "sam",
      kind: "review_feedback",
      title: "review feedback",
      trigger: "human",
      priority: 50,
      subject: { type: "pr", ref: h.ws.prSubject({ repo: REPO, number: pr }) },
    });

    await h.scheduler.markActive(item.id);
    await h.engine.started(item.id);
    expect(await status(key)).toBe("active");

    // A merged pull request's follow-up never reopens anything.
    await merge(pr);
    await h.tracker.transition(key, "done");
    await h.ws.apply(
      { type: "ticket.moved", subject: { ticket: key }, actor: sam, data: { to: "done" } },
      { source: "tracker", externalId: "mv-done-2", trusted: true },
    );

    const late = await h.scheduler.enqueue({
      person: "sam",
      kind: "merged_feedback",
      title: "merged feedback",
      trigger: "human",
      priority: 50,
      subject: { type: "pr", ref: h.ws.prSubject({ repo: REPO, number: pr }) },
    });

    await h.scheduler.markActive(late.id);
    await h.engine.started(late.id);
    expect(await status(key)).toBe("done");
  });
});

describe("failing CI on an open pull request", () => {
  it.each(["review", "done"] as const)(
    "goes to the author with the failing checks, whatever the ticket's status (%s)",
    async (from) => {
      const key = await ticket("active");
      const pr = await open(key, "a");
      await h.tracker.transition(key, from);
      await h.ws.apply(
        { type: "ticket.moved", subject: { ticket: key }, actor: sam, data: { to: from } },
        { source: "tracker", externalId: "mv-from", trusted: true },
      );

      const sha = (await h.vcs.getPullRequest(REPO, pr)).head.sha;
      await h.vcs.seed.check(REPO, sha, { name: "build", status: "pending" });
      await h.poll();
      await h.vcs.seed.check(REPO, sha, { name: "build", status: "failure" });
      await h.ws.rescan();

      const items = (await h.items("sam")).filter((i) => i.kind === "ci_failed");
      expect(items).toHaveLength(1);
      expect(items[0]!.subject?.ref).toBe(`git.acme.example/acme/app#${pr}`);
      expect(await status(key)).toBe("active");
      const [fb] = await readFeedback(h.store, items[0]!.id);
      expect(fb).toMatchObject({ kind: "ci_failure" });
      expect(fb!.body).toContain("build (");

      // The same head raises nothing more.
      await h.ws.rescan();
      expect((await h.items("sam")).filter((i) => i.kind === "ci_failed")).toHaveLength(1);
    },
  );
});

describe("a retry of a blocked ticket", () => {
  const handedBack = (key: string, item: string, state: string): WorkflowEvent => ({
    type: "agent.handed_back",
    subject: { ticket: key },
    actor: sam,
    data: { workItem: item, kind: "assigned", status: state },
  });

  const handle = (event: WorkflowEvent) =>
    h.engine.handle(event, {
      source: "workstate",
      externalId: `hb-${Math.random()}`,
      trusted: true,
    });

  const started = async (key: string) => {
    const item = await h.scheduler.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Search",
      trigger: "human",
      priority: 50,
      subject: { type: "ticket", ref: key },
    });

    await h.scheduler.markActive(item.id);
    await h.engine.started(item.id);
    return item;
  };

  it("that ends still blocked leaves the ticket blocked and runs the blocked routing", async () => {
    const key = await ticket("blocked");
    const item = await started(key);
    expect(await status(key)).toBe("blocked");

    // The agent's free-text "still blocked" arrives as a done hand-back; the ticket is still blocked.
    await handle(handedBack(key, item.id, "done"));
    expect(await status(key)).toBe("blocked");
    expect((await h.items("pat")).map((i) => i.kind)).toEqual(["unblock"]);
  });

  it("that the agent unblocked and finished goes to review", async () => {
    const key = await ticket("blocked");
    const item = await started(key);
    await h.tracker.transition(key, "active");
    await h.ws.apply(
      { type: "ticket.moved", subject: { ticket: key }, actor: sam, data: { to: "active" } },
      { source: "tracker", externalId: "mv-active", trusted: true },
    );

    await handle(handedBack(key, item.id, "done"));
    expect(await status(key)).toBe("review");
    expect(await h.items("pat")).toEqual([]);
  });

  it("closes the earlier blocked item when a new item finishes the ticket", async () => {
    const key = await ticket("active");
    const old = await h.scheduler.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Search",
      trigger: "human",
      priority: 50,
      subject: { type: "ticket", ref: key },
    });

    await h.store.updateItem(old.id, { status: "blocked" });
    const item = await started(key);
    await h.store.updateItem(item.id, { status: "done" });
    await h.engine.settled((await h.store.getItem(item.id))!);
    expect((await h.store.getItem(old.id))?.status).toBe("canceled");
  });

  it("keeps the earlier blocked item while the ticket is still blocked", async () => {
    const key = await ticket("blocked");
    const old = await h.scheduler.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Search",
      trigger: "human",
      priority: 50,
      subject: { type: "ticket", ref: key },
    });

    await h.store.updateItem(old.id, { status: "blocked" });
    const item = await started(key);
    await h.store.updateItem(item.id, { status: "done" });
    await h.engine.settled((await h.store.getItem(item.id))!);
    expect((await h.store.getItem(old.id))?.status).toBe("blocked");
  });
});
