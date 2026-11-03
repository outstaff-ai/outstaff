import { createFakeTracker, createFakeVcs, type FakeTracker } from "@outstaff/core/fakes";
import type { CanonicalStatus, WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState } from "#/workstate/types.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const DANA = { kind: "human" as const, id: "dana" };
const SAM = { kind: "agent" as const, id: "sam" };
const WORKSTATE = { kind: "automation", id: "workstate" };

describe("work state: a ticket it had read open closing raises ticket.closed", () => {
  let clock: ManualClock;
  let store: Store;
  let tracker: FakeTracker;
  let ws: WorkState;
  let seen: WorkflowEvent[];
  let n = 0;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    tracker = createFakeTracker({ now: clock.now });
    seen = [];
    ws = await createWorkState({
      store,
      ports: { vcs: createFakeVcs({ now: clock.now }), tracker },
      team: teamConfig(),
      clock,
      logger: silent,
    });

    ws.onEvent((e) => void seen.push(e));
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  const moved = (key: string, actor: WorkflowEvent["actor"] = DANA, data = {}) =>
    ws.apply(
      { type: "ticket.moved", subject: { ticket: key }, actor, data },
      { source: "tracker", externalId: `m${++n}`, trusted: true },
    );

  const ticket = async (status: CanonicalStatus) => {
    const { key } = await tracker.createIssue({ title: "Greet", body: "", status });
    await moved(key);
    return key;
  };

  const closed = () =>
    seen
      .filter((e) => e.type === "ticket.closed")
      .map((e) => ({ ticket: e.subject.ticket, actor: e.actor, ...e.data }));

  it("names the status, who moved it and when, once per closing", async () => {
    const key = await ticket("active");
    await tracker.transition(key, "canceled");
    clock.advance(1_000);
    const at = "2026-01-01T18:22:16.000Z";
    await moved(key, DANA, { to: "canceled", at });
    expect(closed()).toEqual([
      { ticket: key, actor: WORKSTATE, status: "canceled", closedBy: DANA, at },
    ]);

    await moved(key, DANA, { to: "canceled", at });
    await ws.rescan();
    expect(closed()).toHaveLength(1);
  });

  it("knows a sub-ticket's parent and a parent's sub-tickets", async () => {
    const parent = await ticket("active");
    const { key } = await tracker.createIssue({ title: "Part", body: "", parent, status: "ready" });
    await moved(key);
    expect(ws.parentOf(key)).toBe(parent);
    expect(ws.subTickets(parent)).toEqual([key]);
    expect(ws.subTickets(key)).toEqual([]);
    expect(ws.parentOf("ACME-404")).toBeUndefined();
  });

  it("names the agent whose act or hand-back the ticket was read for", async () => {
    const key = await ticket("review");
    await tracker.transition(key, "done");
    await ws.refreshTicket(key, SAM);
    expect(closed()).toMatchObject([{ ticket: key, status: "done", closedBy: SAM }]);

    // The tracker's echo of the agent's move comes later and raises nothing more.
    await moved(key, SAM, { to: "done" });
    expect(closed()).toHaveLength(1);
  });

  it("names no one for a close a rescan finds, and marks an untrusted human's close", async () => {
    const [found, untrusted] = [await ticket("active"), await ticket("active")];
    await tracker.transition(found, "done");
    await ws.rescan();
    expect(closed()).toEqual([
      { ticket: found, actor: WORKSTATE, status: "done", at: ws.ticket(found)!.statusSince },
    ]);

    await tracker.transition(untrusted, "canceled");
    await moved(untrusted, DANA, { to: "canceled", untrusted: true });
    expect(closed().at(-1)).toMatchObject({ ticket: untrusted, untrusted: true });
  });

  it("raises nothing for a ticket first seen closed, or one that stays open", async () => {
    const { key } = await tracker.createIssue({ title: "Old", body: "", status: "done" });
    await moved(key, DANA, { to: "done" });
    const open = await ticket("active");
    await tracker.transition(open, "review");
    await moved(open, DANA, { to: "review" });
    expect(closed()).toEqual([]);
  });
});
