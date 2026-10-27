import { createFakeTracker, createFakeVcs, type FakeTracker } from "@outstaff/core/fakes";
import type { Tracker, WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "../../clock.js";
import { teamConfig } from "../../intake/test-support.js";
import { openStore } from "../../store/open.js";
import type { Store } from "../../store/types.js";
import type { ManualClock } from "../../types.js";
import type { WorkState } from "../types.js";
import { createWorkState } from "../workstate.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const meta = { source: "tracker" as const, externalId: "e", trusted: true };
const MINUTE = 60_000;

const event = (
  type: WorkflowEvent["type"],
  ticket: string,
  data: Record<string, unknown> = {},
): WorkflowEvent => ({
  type,
  subject: { ticket },
  actor: { kind: "human", id: "ada.admin" },
  data,
});

describe("ready tickets in the work state", () => {
  let clock: ManualClock;
  let store: Store;
  let tracker: FakeTracker;
  let ws: WorkState;

  const build = async (port: Tracker = tracker) => {
    ws = await createWorkState({
      store,
      ports: { vcs: createFakeVcs({ now: clock.now }), tracker: port },
      team: teamConfig(),
      clock,
      logger: silent,
    });
  };

  const ready = (key: string, assignee = "u-sam") =>
    tracker.createIssue({ title: `Ticket ${key}`, body: "", status: "ready", assignee });

  beforeEach(async () => {
    clock = manualClock("2030-01-01T08:00:00.000Z");
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    tracker = createFakeTracker({
      now: clock.now,
      actor: { id: "u-sam", name: "Sam", kind: "agent" },
    });

    await build();
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  it("records when a ticket entered its status, from the event, and keeps it while the status stays", async () => {
    const t = await ready("one");
    clock.advance(MINUTE);
    await ws.apply(event("ticket.created", t.key, { at: "2030-01-01T07:30:00+01:00" }), meta);
    expect(ws.ticket(t.key)).toMatchObject({
      status: "ready",
      statusSince: "2030-01-01T07:30:00+01:00",
    });

    clock.advance(MINUTE);
    await ws.rescan();
    await ws.apply(event("ticket.commented", t.key, { at: "2030-01-01T08:02:00.000Z" }), meta);
    expect(ws.ticket(t.key)?.statusSince).toBe("2030-01-01T07:30:00+01:00");

    clock.advance(MINUTE);
    await tracker.transition(t.key, "active");
    await ws.rescan();
    // Found by a rescan, not an event: the tracker's last update of the ticket is when it moved.
    expect(ws.ticket(t.key)).toMatchObject({
      status: "active",
      statusSince: "2030-01-01T08:03:00.000Z",
    });
  });

  it("lists the ready tickets assigned to the agent, never backlog or someone else's", async () => {
    const ada = await tracker.seed.member({ name: "Ada Admin" });
    const first = await ready("first");
    clock.advance(MINUTE);
    const second = await ready("second");
    await tracker.createIssue({ title: "Later", body: "", status: "backlog", assignee: "u-sam" });
    const theirs = await ready("theirs", ada.id);
    await ws.rescan();
    await ws.apply(event("ticket.created", theirs.key), meta);

    expect(ws.readyTickets("sam")).toEqual([
      { key: first.key, title: "Ticket first", readyAt: "2030-01-01T08:00:00.000Z" },
      { key: second.key, title: "Ticket second", readyAt: "2030-01-01T08:01:00.000Z" },
    ]);

    expect(ws.readyTickets("noor")).toEqual([]);
  });

  it("leaves out a ticket the agent picked up since it entered ready, until it enters ready again", async () => {
    const t = await ready("one");
    await ws.rescan();
    clock.advance(MINUTE);
    const item = await store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "assigned: one",
      trigger: "automation",
      subject: { type: "ticket", ref: t.key },
    });

    await ws.refreshWorkers();
    expect(ws.readyTickets("sam")).toEqual([]);

    // Done, and the ticket never left ready (a preset that does not move tickets): still picked up.
    await store.updateItem(item.id, { status: "done" });
    await ws.refreshWorkers();
    expect(ws.readyTickets("sam")).toEqual([]);

    // Waiting or blocked work is open whenever the ticket entered ready.
    await store.updateItem(item.id, { status: "blocked" });
    await tracker.transition(t.key, "backlog");
    clock.advance(MINUTE);
    await tracker.transition(t.key, "ready");
    await ws.apply(event("ticket.moved", t.key, { at: clock.now().toISOString() }), meta);
    expect(ws.readyTickets("sam")).toEqual([]);

    // Sent back to ready after the work ended: it can be pulled again.
    await store.updateItem(item.id, { status: "done" });
    await ws.refreshWorkers();
    expect(ws.readyTickets("sam").map((r) => r.key)).toEqual([t.key]);

    // Canceled work and answers on the ticket do not count.
    await store.enqueue({
      person: "sam",
      kind: "asked",
      title: "asked",
      trigger: "agent",
      subject: { type: "ticket", ref: t.key },
    });

    await ws.refreshWorkers();
    expect(ws.readyTickets("sam").map((r) => r.key)).toEqual([t.key]);
  });

  it("carries the tracker's priority when the adapter has one", async () => {
    const t = await ready("one");
    await build({
      ...tracker,
      getIssue: async (key) => ({ ...(await tracker.getIssue(key)), priority: 2 }),
    });

    await ws.apply(event("ticket.assigned", t.key, { at: "2030-01-01T07:00:00.000Z" }), meta);
    expect(ws.readyTickets("sam")).toEqual([
      { key: t.key, title: "Ticket one", readyAt: "2030-01-01T07:00:00.000Z", priority: 2 },
    ]);
  });

  it("follows the events alone without a tracker", async () => {
    ws = await createWorkState({
      store,
      ports: { vcs: createFakeVcs({ now: clock.now }) },
      team: teamConfig(),
      clock,
      logger: silent,
    });

    await ws.apply(event("ticket.moved", "ACME-9", { to: "ready" }), meta);
    expect(ws.ticket("ACME-9")).toMatchObject({
      status: "ready",
      statusSince: "2030-01-01T08:00:00.000Z",
    });

    clock.advance(MINUTE);
    await ws.apply(event("ticket.moved", "ACME-9", { to: "ready", at: "x" }), meta);
    await ws.apply(event("ticket.commented", "ACME-9"), meta);
    expect(ws.ticket("ACME-9")?.statusSince).toBe("2030-01-01T08:00:00.000Z");

    await ws.apply(
      event("ticket.moved", "ACME-9", { to: "active", at: "2030-01-01T08:05:00Z" }),
      meta,
    );

    expect(ws.ticket("ACME-9")?.statusSince).toBe("2030-01-01T08:05:00Z");
  });
});
