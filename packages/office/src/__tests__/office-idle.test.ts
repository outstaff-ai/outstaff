import { createFakeTracker, createFakeVcs, type FakeTracker } from "@outstaff/core/fakes";
import type { Logger } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { createIdlePull } from "#/office-idle.js";
import type { IdlePullOptions } from "#/office-idle.types.js";
import { createOfficePipeline } from "#/pipeline/office-pipeline.js";
import type { PipelineEvent } from "#/pipeline/events.types.js";
import { createScheduler, type Scheduler } from "#/scheduler/index.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState } from "#/workstate/types.js";

const MINUTE = 60_000;
const SAM = { id: "u-sam", name: "Sam", kind: "agent" as const };

describe("the idle pull", () => {
  let clock: ManualClock;
  let store: Store;
  let tracker: FakeTracker;
  let ws: WorkState;
  let scheduler: Scheduler;
  let utilization: number;
  let warned: string[];
  let raised: PipelineEvent[];

  const logger: Logger = {
    debug() {},
    info() {},
    warn: (m) => void warned.push(m),
    error() {},
  };

  const pull = (over: Partial<IdlePullOptions> & { policies?: Record<string, unknown> } = {}) => {
    const team = teamConfig(over.policies ? { policies: over.policies } : {});
    const { runner } = createOfficePipeline({
      team,
      store,
      workState: ws,
      scheduler,
      push: () => false,
      clock,
      logger,
    });

    return createIdlePull({
      team,
      store,
      workState: ws,
      scheduler,
      pipeline: {
        judge(event) {
          raised.push(event);
          return runner.judge(event);
        },
      },
      clock,
      logger,
      ...over,
    });
  };

  /** A ready ticket sam assigned to itself, a minute after the previous one. */
  const ready = async (title: string, assignee = SAM.id) => {
    clock.advance(MINUTE);
    return tracker.as(SAM).createIssue({ title, body: "", status: "ready", assignee });
  };

  const items = () => store.listItems({ person: "sam" });

  beforeEach(async () => {
    clock = manualClock("2030-01-01T08:00:00.000Z");
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    tracker = createFakeTracker({ now: clock.now, actor: SAM });
    ws = await createWorkState({
      store,
      ports: { vcs: createFakeVcs({ now: clock.now }), tracker },
      team: teamConfig(),
      clock,
      logger,
    });

    utilization = 0.1;
    scheduler = createScheduler({
      store,
      team: teamConfig(),
      clock,
      usage: { windows: async () => [{ name: "five_hour", utilization }] },
    });

    warned = [];
    raised = [];
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  it("starts the oldest of three ready tickets on the tick, then the next after the hand-back", async () => {
    const first = await ready("Search page");
    const second = await ready("Wishlist");
    await ready("Checkout");
    await ws.rescan();

    const idle = pull();
    await idle.sweep();
    const [item] = await items();
    expect(item).toMatchObject({
      kind: "assigned",
      trigger: "automation",
      title: `assigned: ${first.key} Search page`,
      subject: { type: "ticket", ref: first.key },
    });

    expect(raised.map((e) => [e.type, e.actor, e.id])).toEqual([
      ["agent.idle", { kind: "agent", id: "sam" }, "office:idle:sam:2030-01-01T08:03:00.000Z"],
    ]);

    expect((await store.readJournal(item!.id)).map((j) => j.text)).toContain(
      `You have nothing queued. Start ${first.key}, the next ready ticket assigned to you. Work on it the way the repository asks.`,
    );

    // Busy: nothing more is pulled, and nothing is raised.
    await idle.sweep();
    expect(await items()).toHaveLength(1);
    expect(raised).toHaveLength(1);

    const started = await scheduler.markActive(item!.id);
    expect(started.started).toBe(true);
    await scheduler.finish(item!.id, { outcome: "done" });
    await idle.check("sam");
    expect((await items()).map((i) => i.subject?.ref)).toEqual([first.key, second.key]);
  });

  it("takes the tracker's priority first", async () => {
    await ready("Old");
    const urgent = await ready("Urgent");
    ws = await createWorkState({
      store,
      ports: {
        vcs: createFakeVcs({ now: clock.now }),
        tracker: {
          ...tracker,
          listIssues: async (f) =>
            (await tracker.listIssues(f)).map((i) =>
              i.key === urgent.key ? { ...i, priority: 1 } : i,
            ),
        },
      },
      team: teamConfig(),
      clock,
      logger,
    });

    await ws.rescan();
    await pull().check("sam");
    expect((await items()).map((i) => i.subject?.ref)).toEqual([urgent.key]);
  });

  it("stops above pause_automatic_at and while paused, but a human's request still runs", async () => {
    await ready("Search page");
    await ws.rescan();
    utilization = 0.97;
    const idle = pull();
    await idle.check("sam");
    expect(await items()).toEqual([]);

    const asked = await scheduler.enqueue({
      person: "sam",
      kind: "chat",
      title: "A question from Dana",
      trigger: "human",
    });

    // A chat session is no work item: sam is still idle, and still held.
    await idle.check("sam");
    expect((await scheduler.next("sam"))?.id).toBe(asked.id);
    expect((await items()).map((i) => i.id)).toEqual([asked.id]);

    utilization = 0.1;
    await scheduler.pause("sam", "holiday");
    await idle.check("sam");
    expect(await items()).toHaveLength(1);
    expect(raised).toEqual([]);

    await scheduler.resume("sam");
    await idle.check("sam");
    expect(await items()).toHaveLength(2);
  });

  it("never pulls a ticket in backlog or someone else's, nor for anyone but an agent", async () => {
    const ada = await tracker.seed.member({ name: "Ada Admin" });
    await ready("Theirs", ada.id);
    clock.advance(MINUTE);
    await tracker.as(SAM).createIssue({ title: "Later", body: "", assignee: SAM.id });
    await ws.rescan();

    const idle = pull();
    await idle.sweep();
    await idle.check("dana");
    expect(await store.listItems()).toEqual([]);
    expect(raised).toEqual([]);
  });

  it("does nothing while policies.pull_ready is off", async () => {
    await ready("Search page");
    await ws.rescan();
    await pull({ policies: { pull_ready: false } }).sweep();
    expect(await items()).toEqual([]);
  });

  it("checks the agent at once when a ticket change gives it a ready ticket, once for a burst", async () => {
    const ada = await tracker.seed.member({ name: "Ada Admin" });
    const mine = await ready("Search page");
    const theirs = await ready("Theirs", ada.id);
    await ws.rescan();
    const idle = pull();
    const change = (type: "ticket.assigned" | "ticket.commented", ticket: string) => ({
      type,
      subject: { ticket },
      actor: { kind: "agent" as const, id: "sam" },
      data: {},
    });

    // Neither a comment, someone else's ticket, nor an event without a ticket checks anyone.
    await idle.afterEvent(change("ticket.commented", mine.key));
    await idle.afterEvent(change("ticket.assigned", theirs.key));
    await idle.afterEvent({ ...change("ticket.assigned", mine.key), subject: {} });
    expect(raised).toEqual([]);

    // A burst of changes queues one item.
    await Promise.all([
      idle.afterEvent(change("ticket.assigned", mine.key)),
      idle.afterEvent({ ...change("ticket.assigned", mine.key), type: "ticket.created" }),
      idle.afterEvent({ ...change("ticket.assigned", mine.key), type: "ticket.moved" }),
    ]);

    expect((await items()).map((i) => i.subject?.ref)).toEqual([mine.key]);
    expect(raised).toHaveLength(1);

    // A ticket that is not ready checks no one.
    await tracker.transition(mine.key, "active");
    await ws.rescan();
    await idle.afterEvent({ ...change("ticket.assigned", mine.key), type: "ticket.moved" });
    expect(raised).toHaveLength(1);
  });

  it("logs a failed check instead of throwing, and the next check works", async () => {
    await ready("Search page");
    await ws.rescan();
    let broken = true;
    const idle = pull({
      workState: {
        refreshWorkers: () =>
          broken ? Promise.reject(new Error("store down")) : ws.refreshWorkers(),
        readyTickets: (p) => ws.readyTickets(p),
        assignee: (t) => ws.assignee(t),
        ticketStatus: (t) => ws.ticketStatus(t),
      },
    });

    await idle.check("sam");
    expect(warned).toEqual(["idle pull failed"]);
    broken = false;
    await idle.check("sam");
    expect(await items()).toHaveLength(1);
  });
});
