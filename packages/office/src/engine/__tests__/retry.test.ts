import type { PrRef, WorkflowEvent } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { REPO, teamConfig } from "#/intake/test-support.js";
import { harness, SAM, type Harness, type HarnessOptions } from "./test-support.js";

const dana = { kind: "human", id: "dana" } as const;
const ref = (number: number): PrRef => ({ repo: REPO, number });

let h: Harness;
afterEach(() => h.close());

/** A ticket sam works on, its pull request, and sam's item for the ticket blocked by repeated failures. */
async function blockedSetup(subject: "ticket" | "pr" = "ticket", over: HarnessOptions = {}) {
  h = await harness(over);
  await h.human("Dana");
  const issue = await h.tracker.createIssue({
    title: "Search",
    body: "",
    status: "review",
    assignee: "u-sam",
  });

  await h.ws.apply(
    { type: "ticket.created", subject: { ticket: issue.key }, actor: dana, data: {} },
    { source: "tracker", externalId: "c", trusted: true },
  );

  const pr = await h.vcs.seed.pullRequest(REPO, {
    title: "Search",
    head: { ref: `sam/${issue.key.toLowerCase()}` },
    author: { login: SAM, kind: "agent" },
  });

  await h.ws.apply(
    { type: "pr.opened", subject: { pr: ref(pr.number) }, actor: dana, data: {} },
    { source: "vcs", externalId: "o", trusted: true },
  );

  const item = await h.store.enqueue({
    person: "sam",
    kind: "implement",
    title: "Implement: Search",
    trigger: "agent",
    subject:
      subject === "ticket"
        ? { type: "ticket", ref: issue.key }
        : { type: "pr", ref: h.ws.prSubject(ref(pr.number)) },
  });

  await h.store.updateItem(item.id, {
    status: "blocked",
    failures: 3,
    notBefore: "2030-01-01T00:00:00.000Z",
    sessionId: "session-1",
  });

  await h.store.appendJournal(item.id, "agent", "Tried the migration.");
  for (let i = 0; i < 3; i++) {
    await h.store.recordLoopGuard(item.id);
  }

  const event = (
    type: WorkflowEvent["type"],
    actor: WorkflowEvent["actor"],
    data: Record<string, unknown> = {},
  ): WorkflowEvent => ({
    type,
    subject: type.startsWith("pr.")
      ? { pr: ref(pr.number), ticket: issue.key }
      : { ticket: issue.key },
    actor,
    data,
  });

  return { key: issue.key, pr, itemId: item.id, event };
}

const state = async (id: string) => {
  const item = (await h.store.getItem(id))!;
  return {
    status: item.status,
    failures: item.failures,
    notBefore: item.notBefore,
    sessionId: item.sessionId,
    guard: await h.store.countLoopGuard(id, 60 * 60_000),
  };
};

const BLOCKED = { status: "blocked", failures: 3, guard: 3 };

describe("policies.retry.on_signal", () => {
  it("off: a human's signal leaves the blocked item blocked and a PR comment schedules a new round", async () => {
    const team = teamConfig({
      humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "dana" } }],
      policies: { retry: { on_signal: false } },
    });

    const { itemId, event } = await blockedSetup("pr", { team });
    await h.deliver(event("ticket.moved", dana, { to: "active" }));
    await h.deliver(event("pr.comment", dana, { body: "Please cover the empty query." }));
    expect(await state(itemId)).toMatchObject(BLOCKED);
    expect((await h.store.readJournal(itemId)).map((j) => j.text)).toEqual([
      "Tried the migration.",
    ]);

    expect((await h.items("sam")).filter((i) => i.id !== itemId).map((i) => i.kind)).toEqual([
      "review_feedback",
    ]);
  });
});

describe("a trusted human retries a blocked item", () => {
  it("moves the ticket out of blocked", async () => {
    const { key, itemId, event } = await blockedSetup();
    await h.deliver(event("ticket.moved", dana, { to: "active" }));

    expect(await state(itemId)).toEqual({
      status: "queued",
      failures: 0,
      notBefore: null,
      sessionId: "session-1",
      guard: 0,
    });

    const journal = (await h.store.readJournal(itemId)).map((j) => j.text);
    expect(journal[0]).toBe("Tried the migration.");
    expect(journal.at(-1)).toBe("Retried on request by dana (ticket moved).");
    expect((await h.tracker.listComments(key)).map((c) => c.body)).toContain(
      `Retrying ${key} on request`,
    );
  });

  it("moves it to ready as well, but not anywhere else", async () => {
    const { itemId, event } = await blockedSetup();
    await h.deliver(event("ticket.moved", dana, { to: "backlog" }));
    await h.deliver(event("ticket.moved", dana, { to: "blocked" }));
    expect(await state(itemId)).toMatchObject(BLOCKED);

    await h.deliver(event("ticket.moved", dana, { to: "ready" }));
    expect((await state(itemId)).status).toBe("queued");
  });

  it("assigns the ticket to the item's person again, and only to them", async () => {
    const { itemId, event, key } = await blockedSetup();
    await h.tracker.assign(key, (await h.human("Grace")).id);
    await h.deliver(event("ticket.assigned", dana));
    expect(await state(itemId)).toMatchObject(BLOCKED);

    await h.tracker.assign(key, "u-sam");
    await h.deliver(event("ticket.assigned", dana));
    expect((await state(itemId)).status).toBe("queued");
    expect(await h.items("sam")).toHaveLength(1);
  });

  it("comments on the pull request, and no second item runs beside it", async () => {
    const { itemId, event } = await blockedSetup();
    await h.deliver(event("pr.comment", dana, { body: "Please cover the empty query." }));

    expect(await state(itemId)).toMatchObject({ status: "queued", failures: 0, guard: 0 });
    const journal = (await h.store.readJournal(itemId)).map((j) => j.text);
    expect(journal).toContain("PR comment: Please cover the empty query.");
    expect(journal).toContain("Retried on request by dana (PR comment).");

    // The review_feedback rule would have queued an item for the author; the retried one carries the feedback.
    expect(await h.items("sam")).toHaveLength(1);
  });

  it("reviews a pull request that the blocked item is about", async () => {
    const { itemId, event } = await blockedSetup("pr");
    const out = await h.deliver(
      event("pr.review_submitted", dana, { state: "changes_requested", body: "Rename it." }),
    );

    expect(await state(itemId)).toMatchObject({ status: "queued", failures: 0 });
    expect(await h.items("sam")).toHaveLength(1);
    expect(out.some((o) => o.status === "skipped" && o.note.includes("retried on request"))).toBe(
      true,
    );
  });

  it("still queues review_feedback when nothing is blocked", async () => {
    const { itemId, event } = await blockedSetup();
    await h.store.updateItem(itemId, { status: "done" });
    await h.deliver(event("pr.comment", dana, { body: "Looks off." }));
    const items = await h.items("sam");
    expect(items.map((i) => i.kind).toSorted()).toEqual(["implement", "review_feedback"]);
  });

  it("retries once when the event is delivered again", async () => {
    const { itemId, event } = await blockedSetup();
    const e = event("ticket.moved", dana, { to: "active" });
    const meta = { source: "tracker", externalId: "same", trusted: true } as const;
    await h.ws.apply(e, meta);
    await h.engine.handle(e, meta);
    await h.store.updateItem(itemId, { status: "blocked" });
    await h.engine.handle(e, meta);
    expect((await state(itemId)).status).toBe("blocked");
  });
});

describe("nobody else retries a blocked item", () => {
  it("ignores an agent", async () => {
    const { itemId, event } = await blockedSetup();
    for (const e of [
      event("ticket.moved", { kind: "agent", id: "pat" }, { to: "active" }),
      event("ticket.assigned", { kind: "agent", id: "pat" }),
      event("pr.comment", { kind: "agent", id: "pat" }, { body: "Please redo." }),
      event("pr.review_submitted", { kind: "agent", id: "sam" }, { state: "approved" }),
    ]) {
      await h.deliver(e);
    }

    expect(await state(itemId)).toMatchObject(BLOCKED);
  });

  it("ignores a bot or an automation", async () => {
    const { itemId, event } = await blockedSetup();
    await h.deliver(event("ticket.moved", { kind: "automation", id: "ci[bot]" }, { to: "active" }));
    await h.deliver(event("pr.comment", { kind: "automation", id: "ci[bot]" }, { body: "x" }));
    expect(await state(itemId)).toMatchObject(BLOCKED);
  });

  it("ignores a human who is not trusted", async () => {
    const { itemId, event } = await blockedSetup();
    await h.deliver(event("ticket.moved", { kind: "human", id: "eve" }, { to: "active" }), false);
    await h.deliver(
      event("pr.comment", { kind: "human", id: "eve" }, { body: "x", untrusted: true }),
    );

    expect(await state(itemId)).toMatchObject(BLOCKED);
  });

  it("leaves the blocked items of other tickets alone", async () => {
    const { itemId, event } = await blockedSetup();
    const other = await h.store.enqueue({
      person: "sam",
      kind: "implement",
      title: "Other",
      trigger: "agent",
      subject: { type: "ticket", ref: "OTHER-1" },
    });

    await h.store.updateItem(other.id, { status: "blocked" });
    await h.deliver(event("ticket.moved", dana, { to: "active" }));
    expect((await state(itemId)).status).toBe("queued");
    expect((await h.store.getItem(other.id))?.status).toBe("blocked");
  });
});
