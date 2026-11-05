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

describe("work state: closing a ticket unblocks the tickets it blocks", () => {
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

  /** A ticket in a status, as the work state has read it. */
  const ticket = async (title: string, status: CanonicalStatus) => {
    const { key } = await tracker.createIssue({ title, body: "", status });
    await moved(key);
    return key;
  };

  /** Moves a ticket in the tracker and tells the work state, as intake would. */
  const close = async (key: string, to: CanonicalStatus = "done", actor = DANA, data = {}) => {
    await tracker.transition(key, to);
    clock.advance(1_000);
    await moved(key, actor, { to, ...data });
  };

  const unblocked = () =>
    seen
      .filter((e) => e.type === "ticket.unblocked")
      .map((e) => ({ ticket: e.subject.ticket, actor: e.actor, ...e.data, at: undefined }));

  it("raises ticket.unblocked once on each blocked ticket the closed one blocked, naming it", async () => {
    const blocker = await ticket("Pick the font", "active");
    const [a, b] = [await ticket("Set the font", "blocked"), await ticket("Size", "blocked")];
    await tracker.link(blocker, a, "blocks");
    await tracker.link(blocker, b, "blocks");
    await moved(blocker);

    await close(blocker);
    const workstate = { kind: "automation", id: "workstate" };
    expect(unblocked()).toEqual([
      { ticket: a, actor: workstate, blocker, blockerTitle: "Pick the font", closedBy: DANA },
      { ticket: b, actor: workstate, blocker, blockerTitle: "Pick the font", closedBy: DANA },
    ]);

    // The same close read again, a rescan, a restart: nothing more.
    await moved(blocker, DANA, { to: "done" });
    await ws.rescan();
    await ws.refreshTicket(blocker, SAM);
    expect(unblocked()).toHaveLength(2);
  });

  it("names the parent and its agent when the ticket and its blocker are sub-tickets of one parent", async () => {
    const agent = await tracker.seed.member({ name: "Sam", username: "sam", kind: "agent" });
    const parent = await ticket("Fonts", "active");
    await tracker.assign(parent, agent.id);
    const [first, second] = [await ticket("Pick", "active"), await ticket("Set", "blocked")];
    const elsewhere = await ticket("Size", "blocked");
    for (const key of [first, second]) {
      await tracker.setParent!(key, parent);
    }

    await tracker.link(first, second, "blocks");
    await tracker.link(first, elsewhere, "blocks");
    await Promise.all([moved(first), moved(second), moved(elsewhere)]);

    await close(first);
    const [sibling, other] = unblocked();
    expect(sibling).toMatchObject({ ticket: second, parent, parentAgent: agent.id });
    expect(other).toMatchObject({ ticket: elsewhere });
    expect(other).not.toHaveProperty("parent");
  });

  it("waits for the last open blocker, and counts a canceled one as closed", async () => {
    const [first, second] = [await ticket("One", "active"), await ticket("Two", "review")];
    const blocked = await ticket("Both", "blocked");
    await tracker.link(first, blocked, "blocks");
    await tracker.link(second, blocked, "blocks");
    await Promise.all([moved(first), moved(second)]);

    await close(first);
    expect(unblocked()).toEqual([]);
    await close(second, "canceled");
    expect(unblocked()).toMatchObject([{ ticket: blocked, blocker: second }]);
  });

  it("raises nothing for a ticket that is not blocked, or a blocker first seen closed", async () => {
    const blocker = await ticket("Blocker", "active");
    const ready = await ticket("Ready", "ready");
    await tracker.link(blocker, ready, "blocks");
    await moved(blocker);
    await close(blocker);

    const { key: old } = await tracker.createIssue({ title: "Old", body: "", status: "done" });
    const waiting = await ticket("Waiting", "blocked");
    await tracker.link(old, waiting, "blocks");
    await moved(old, DANA, { to: "done" });
    expect(unblocked()).toEqual([]);
  });

  it("names the agent the office read the ticket for, after its act closed it", async () => {
    const blocker = await ticket("Blocker", "review");
    const blocked = await ticket("Blocked", "blocked");
    await tracker.link(blocker, blocked, "blocks");
    await moved(blocker);

    await tracker.transition(blocker, "done");
    await ws.refreshTicket(blocker, SAM);
    expect(unblocked()).toMatchObject([{ ticket: blocked, blocker, closedBy: SAM }]);

    // The tracker's echo of the move comes later and raises nothing more.
    await moved(blocker, SAM, { to: "done" });
    expect(unblocked()).toHaveLength(1);
  });

  it("sees a close in a rescan, once, naming no one", async () => {
    const blocker = await ticket("Blocker", "active");
    const blocked = await ticket("Blocked", "blocked");
    await tracker.link(blocker, blocked, "blocks");
    await moved(blocker);

    await tracker.transition(blocker, "done");
    await ws.rescan();
    await ws.rescan();
    expect(unblocked()).toEqual([
      {
        ticket: blocked,
        actor: { kind: "automation", id: "workstate" },
        blocker,
        blockerTitle: "Blocker",
      },
    ]);
  });

  it("marks the event untrusted when an untrusted human closed the blocker", async () => {
    const blocker = await ticket("Blocker", "active");
    const blocked = await ticket("Blocked", "blocked");
    await tracker.link(blocker, blocked, "blocks");
    await moved(blocker);
    await close(blocker, "done", DANA, { untrusted: true });
    expect(unblocked()).toMatchObject([{ ticket: blocked, untrusted: true }]);
  });

  it("keeps the links it read on the ticket's record", async () => {
    const blocker = await ticket("Blocker", "active");
    const blocked = await ticket("Blocked", "blocked");
    await tracker.link(blocker, blocked, "blocks");
    await Promise.all([moved(blocker), moved(blocked)]);
    expect(ws.ticket(blocker)).toMatchObject({ blocks: [blocked], blockedBy: [] });
    expect(ws.ticket(blocked)).toMatchObject({
      blocks: [],
      blockedBy: [{ key: blocker, status: "active" }],
    });
  });

  it("names the blockers still open, for the policies, until they close", async () => {
    const open = await ticket("Open blocker", "active");
    const closed = await ticket("Closed blocker", "done");
    const blocked = await ticket("Blocked", "blocked");
    await tracker.link(open, blocked, "blocks");
    await tracker.link(closed, blocked, "blocks");
    await Promise.all([moved(open), moved(blocked)]);
    expect(ws.openBlockers(blocked)).toEqual([open]);
    expect(ws.openBlockers("SHOP-404")).toEqual([]);

    await close(open, "done");
    expect(ws.openBlockers(blocked)).toEqual([]);
    expect(unblocked()).toMatchObject([{ ticket: blocked, blocker: open }]);
  });
});
