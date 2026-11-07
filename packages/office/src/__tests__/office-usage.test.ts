import { silentLogger, type TeamConfig, type Tracker } from "@outstaff/core";
import { createFakeTracker } from "@outstaff/core/fakes";
import type { SessionUsageReport } from "@outstaff/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { officeUsage } from "#/office-usage.js";
import type { PendingAct } from "#/pipeline/act/act.types.js";
import { createScheduler } from "#/scheduler/index.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import { schedulerWorkSource } from "#/work-source.js";

const usage: SessionUsageReport[] = [
  {
    session: "s1",
    models: {
      "claude-opus-5-5": {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
        costUsd: 0.5,
      },
    },
  },
];

const team = {
  people: [],
  policies: {
    agent_loop_guard: { max_runs_per_subject_per_hour: 12 },
    usage: { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 },
    retry: { base_minutes: 1, cap_minutes: 30, max_failures: 3 },
  },
} as unknown as TeamConfig;

describe("the office's usage tracking", () => {
  let store: Store;
  let clock: ManualClock;
  let sent: { person: string; act: PendingAct }[];
  let warned: string[];
  let tracker: Tracker;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    sent = [];
    warned = [];
    tracker = createFakeTracker();
  });

  afterEach(async () => {
    await store.close();
  });

  const build = (settings?: TeamConfig["usage"], pollIntervalMs?: number) => {
    const tracked = officeUsage({
      team: settings ? { usage: settings } : {},
      store,
      ports: { tracker },
      acts: { send: async (person, act) => void sent.push({ person, act }) },
      capabilities: ["tracker.issues", "tracker.fields"],
      clock,
      log: { ...silentLogger, warn: (m: string) => void warned.push(m) },
      options: pollIntervalMs === undefined ? {} : { pollIntervalMs },
    });

    const scheduler = createScheduler({ store, team, clock });
    const source = schedulerWorkSource({
      scheduler,
      store,
      team,
      logger: { warn: (m: string) => void warned.push(m) },
      ...(tracked.recordUsage ? { recordUsage: tracked.recordUsage } : {}),
    });

    return { tracked, scheduler, source };
  };

  const start = async (s: ReturnType<typeof build>, ticket: string) => {
    await s.scheduler.enqueue({
      person: "sam",
      kind: "assigned",
      title: "t",
      trigger: "human",
      subject: { type: "ticket", ref: ticket },
    });

    const id = (await s.source.next("sam"))!.workItem.id;
    await s.source.accept("sam", id, { runtime: "claude", model: "sonnet" });
    return id;
  };

  it("records a handed-back round's usage and has the agent write the ticket's fields", async () => {
    const issue = await tracker.createIssue({ title: "t", body: "" });
    const s = build(undefined, 100);
    const id = await start(s, issue.key);
    await s.source.handBack("sam", id, { summary: "ok", links: [], status: "done", usage });
    expect(await s.tracked.ticketUsage.read(issue.key)).toMatchObject({
      total: { tokens: 10, costUsd: 0.5, runs: 1 },
    });

    expect(await s.tracked.link?.ticket(issue.key)).toMatchObject({ total: { tokens: 10 } });
    clock.advance(200);
    for (let i = 0; i < 50 && sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(
      sent.map((x) => [x.person, x.act.ops.map((o) => (o as { value: number }).value)]),
    ).toEqual([["sam", [10, 0.5]]]);

    s.tracked.stop();
  });

  it("records a failed round's usage, and logs a round it cannot record", async () => {
    const s = build({ track_cost: true, tracker_fields: false });
    const id = await start(s, "ACME-1");
    await s.source.fail("sam", id, "crashed", usage);
    expect((await s.tracked.ticketUsage.read("ACME-1")).total.runs).toBe(1);

    const scheduler = createScheduler({ store, team, clock });
    const failing = schedulerWorkSource({
      scheduler,
      store,
      team,
      logger: { warn: (m: string) => void warned.push(m) },
      recordUsage: async () => Promise.reject(new Error("store down")),
    });

    await scheduler.enqueue({ person: "ann", kind: "k", title: "t", trigger: "human" });
    const other = (await failing.next("ann"))!.workItem.id;
    await failing.handBack("ann", other, { summary: "ok", links: [], status: "done", usage });
    expect(warned).toEqual(["could not record the usage of a round"]);
    expect((await store.getItem(other))?.status).toBe("done");
  });

  it("records nothing and answers no totals when the team does not track usage", async () => {
    const s = build({ track_cost: false, tracker_fields: true });
    expect(s.tracked.recordUsage).toBeUndefined();
    expect(s.tracked.link).toBeUndefined();
    const id = await start(s, "ACME-1");
    await s.source.handBack("sam", id, { summary: "ok", links: [], status: "done", usage });
    await expect(s.tracked.ticketUsage.read("ACME-1")).rejects.toMatchObject({ code: "invalid" });
    expect(await store.listRunUsage({})).toEqual([]);
  });
});
