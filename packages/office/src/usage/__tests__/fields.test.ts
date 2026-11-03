import { createFakeTracker, type FakeTracker } from "@outstaff/core/fakes";
import { silentLogger } from "@outstaff/core";
import type { SessionUsageReport } from "@outstaff/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import type { PendingAct } from "#/pipeline/act/act.types.js";
import { openStore, type Store } from "#/store/index.js";
import type { WorkItem } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import { createUsageFields, recordRoundUsage, ticketUsage } from "#/usage/index.js";

const MODEL = "claude-opus-5-5";

/** A session's running total after `n` rounds of 100 tokens of each kind and a dollar each. */
const report = (session: string, n: number): SessionUsageReport[] => [
  {
    session,
    models: {
      [MODEL]: {
        inputTokens: 100 * n,
        outputTokens: 100 * n,
        cacheReadTokens: 100 * n,
        cacheCreationTokens: 100 * n,
        costUsd: n,
      },
    },
  },
];

describe("usage per ticket", () => {
  let store: Store;
  let clock: ManualClock;
  let tracker: FakeTracker;
  let sent: { person: string; act: PendingAct }[];
  let warned: string[];

  beforeEach(async () => {
    clock = manualClock("2026-10-05T10:00:00.000Z");
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    tracker = createFakeTracker();
    sent = [];
    warned = [];
  });

  afterEach(async () => {
    await store.close();
  });

  const log = { ...silentLogger, warn: (m: string) => void warned.push(m) };
  const fields = () =>
    createUsageFields({
      store,
      tracker,
      acts: { send: async (person, act) => void sent.push({ person, act }) },
      clock,
      log,
      debounceMs: 1000,
    });

  /** A round of the person's item on the ticket, reporting the session's running total after `n` rounds. */
  async function round(item: WorkItem, session: string, n: number) {
    await store.startRun(item.id);
    expect(await recordRoundUsage(store, item.id, report(session, n))).toBe(true);
    const run = (await store.listRuns(item.id)).at(-1)!;
    await store.finishRun(run.id, { outcome: "done" });
  }

  const item = (ticket: string | undefined, person = "sam", kind = "assigned") =>
    store.enqueue({
      person,
      kind,
      title: "t",
      trigger: "human",
      ...(ticket ? { subject: { type: "ticket", ref: ticket } } : {}),
    });

  it("counts what is new in each round of a resumed session, and nothing without an open run", async () => {
    const a = await item("ACME-1");
    await round(a, "s1", 1);
    await round(a, "s1", 3);
    expect(await recordRoundUsage(store, a.id, report("s1", 4))).toBe(false);
    const usage = await ticketUsage({ store, log }, "ACME-1");
    expect(usage.own).toEqual({
      inputTokens: 300,
      outputTokens: 300,
      cacheReadTokens: 300,
      cacheCreationTokens: 300,
      tokens: 1200,
      costUsd: 3,
      runs: 2,
    });

    expect(usage.total).toEqual(usage.own);
    expect(usage.subTickets).toEqual([]);
  });

  it("totals the ticket's items by person, model and kind, and rolls its sub-tickets up", async () => {
    const parent = await tracker.createIssue({ title: "Parent", body: "" });
    const child = await tracker.createIssue({ title: "Child", body: "", parent: parent.key });
    await tracker.setParent!(child.key, parent.key);
    await round(await item(parent.key), "p", 1);
    const review = await item(undefined, "pia", "review_feedback");
    await store.addItemRefs(review.id, [
      { type: "ticket", ref: parent.key, role: "inferred", source: "test" },
    ]);

    await round(review, "r", 2);
    await round(await item(child.key), "c", 1);

    const usage = await ticketUsage({ store, tracker, log }, parent.key);
    expect(usage.own.tokens).toBe(1200);
    expect(usage.total).toMatchObject({ tokens: 1600, costUsd: 4, runs: 3 });
    expect(usage.subTickets).toEqual([
      { ticket: child.key, total: expect.objectContaining({ tokens: 400 }) },
    ]);

    expect(usage.byPerson.map((g) => [g.key, g.totals.costUsd])).toEqual([
      ["pia", 2],
      ["sam", 1],
    ]);

    expect(usage.byModel.map((g) => g.key)).toEqual([MODEL]);
    expect(usage.byKind.map((g) => g.key)).toEqual(["review_feedback", "assigned"]);
  });

  it("rolls nothing up when the tracker cannot list sub-tickets", async () => {
    await round(await item("ACME-1"), "s", 1);
    const broken = { listIssues: async () => Promise.reject(new Error("down")) };
    const usage = await ticketUsage({ store, tracker: broken, log }, "ACME-1");
    expect(usage.total.tokens).toBe(400);
    expect(warned).toEqual(["could not list the sub-tickets of a ticket"]);
  });

  it("writes a burst of rounds once, as the agent, then the parent's roll-up", async () => {
    const parent = await tracker.createIssue({ title: "Parent", body: "" });
    const child = await tracker.createIssue({ title: "Child", body: "" });
    await tracker.setParent!(child.key, parent.key);
    const writer = fields();
    const a = await item(child.key);
    await round(a, "s", 1);
    await writer.touched(a);
    clock.advance(500);
    await round(a, "s", 2);
    await writer.touched(a);
    clock.advance(999);
    expect(sent).toEqual([]);

    clock.advance(1);
    await until(() => sent.length === 1);
    expect(sent[0]).toMatchObject({
      person: "sam",
      act: {
        id: `usage:${child.key}:2026-10-05T10:00:01.500Z`,
        ops: [
          { op: "set_field", ticket: child.key, field: "Agent tokens", value: 800 },
          {
            op: "set_field",
            ticket: child.key,
            field: "Agent cost, USD (API-equivalent)",
            value: 2,
          },
        ],
      },
    });

    clock.advance(1000);
    await until(() => sent.length === 2);
    expect(sent[1]?.act.ops[0]).toMatchObject({ ticket: parent.key, value: 800 });

    // Nothing new: the same totals are not written again.
    await writer.touched(a);
    clock.advance(1000);
    await settle();
    expect(sent).toHaveLength(2);
  });

  it("writes nothing for an item without a ticket, and drops waiting writes when stopped", async () => {
    const writer = fields();
    const loose = await item(undefined);
    await round(loose, "s", 1);
    await writer.touched(loose);
    const a = await item("ACME-1");
    await round(a, "t", 1);
    await writer.touched(a);
    writer.stop();
    clock.advance(5000);
    await settle();
    expect(sent).toEqual([]);
  });

  it("logs a ticket it cannot read, and a write it cannot queue", async () => {
    const writer = createUsageFields({
      store,
      tracker,
      acts: { send: async () => Promise.reject(new Error("queue down")) },
      clock,
      log,
      debounceMs: 10,
    });

    const a = await item("ACME-404");
    await round(a, "s", 1);
    await writer.touched(a);
    clock.advance(10);
    await until(() => warned.length > 0);
    expect(warned).toEqual(["could not write the usage fields of a ticket"]);

    const issue = await tracker.createIssue({ title: "Known", body: "" });
    const ok = createUsageFields({
      store,
      tracker: { ...tracker, getIssue: async () => Promise.reject(new Error("gone")) },
      acts: { send: async (person, act) => void sent.push({ person, act }) },
      clock,
      log,
      debounceMs: 10,
    });

    const b = await item(issue.key);
    await round(b, "t", 1);
    await ok.touched(b);
    clock.advance(10);
    await until(() => warned.length > 1);
    expect(warned[1]).toBe("could not read the parent of a ticket");
    expect(sent).toHaveLength(1);
  });
});

/** Lets the timers' async work run. */
const settle = () => new Promise((r) => setTimeout(r, 20));

async function until(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }

  expect(ok()).toBe(true);
}
