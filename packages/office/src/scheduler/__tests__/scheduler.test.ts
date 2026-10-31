import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TeamConfig } from "@outstaff/core";
import { manualClock } from "#/clock.js";
import type { ManualClock } from "#/types.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import { createScheduler } from "#/scheduler/scheduler.js";
import type { Scheduler, UsageSource } from "#/scheduler/types.js";

const team = {
  policies: {
    agent_loop_guard: { max_runs_per_item_per_hour: 3 },
    usage: { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 },
    retry: { base_minutes: 1, cap_minutes: 30, max_failures: 3 },
  },
} as Pick<TeamConfig, "policies">;

interface Harness {
  open(now: () => Date): Promise<Store>;
  cleanup(): Promise<void>;
}

const harnesses: [string, () => Harness][] = [
  [
    "sqlite file",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "outstaff-sched-"));
      return {
        open: (now) => openStore(`sqlite://${join(dir, "office.db")}`, { now }),
        cleanup: async () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  ],
];

const pgUrl = process.env["OUTSTAFF_TEST_POSTGRES_URL"] ?? "";
if (pgUrl) {
  harnesses.push([
    "postgres",
    () => {
      const schema = `t_${randomUUID().replaceAll("-", "")}`;
      return {
        open: (now) => openStore(pgUrl, { now, schema }),
        cleanup: async () => {
          const c = new Client({ connectionString: pgUrl });
          await c.connect();
          try {
            await c.query(`drop schema if exists "${schema}" cascade`);
          } finally {
            await c.end();
          }
        },
      };
    },
  ]);
}

describe.each(harnesses)("scheduler on %s", (_name, makeHarness) => {
  let h: Harness;
  let clock: ManualClock;
  let store: Store;
  let usage: { windows: { name: string; utilization: number }[]; fail: boolean };
  let sched: Scheduler;

  const usageSource: UsageSource = {
    async windows() {
      if (usage.fail) {
        throw new Error("down");
      }

      return usage.windows;
    },
  };

  const build = (staleAfterMinutes = 10) =>
    createScheduler({ store, team, clock, usage: usageSource, staleAfterMinutes });

  beforeEach(async () => {
    h = makeHarness();
    clock = manualClock();
    usage = { windows: [], fail: false };
    store = await h.open(() => clock.now());
    sched = build();
  });

  afterEach(async () => {
    sched.stop();
    await store.close().catch(() => undefined);
    await h.cleanup();
  });

  const add = (
    title: string,
    trigger: "human" | "agent" | "automation" | "schedule" = "human",
    extra: { kind?: string; person?: string } = {},
  ) =>
    sched.enqueue({
      person: extra.person ?? "ann",
      kind: extra.kind ?? "task",
      title,
      trigger,
    });

  it("runs init on the created item before enqueue returns, while it is still queued", async () => {
    const seen: string[] = [];
    const item = await sched.enqueue({
      person: "ann",
      kind: "task",
      title: "with init",
      trigger: "human",
      init: async (created) => {
        seen.push(`${created.title}:${(await store.getItem(created.id))?.status}`);
      },
    });

    expect(seen).toEqual(["with init:queued"]);
    expect(item.status).toBe("queued");
  });

  const titles = async (person = "ann") =>
    (await store.listItems({ person, status: "queued" }))
      .toSorted((a, b) => a.priority - b.priority || a.position - b.position)
      .map((i) => i.title);

  const runNext = async (person = "ann") => {
    const item = await sched.next(person);
    expect(item).not.toBeNull();
    const res = await sched.markActive(item!.id);
    expect(res.started).toBe(true);
    return item!;
  };

  describe("priorities", () => {
    it("runs chat, human, agent, automation, schedule in that order", async () => {
      await add("sched", "schedule");
      await add("auto", "automation");
      await add("agent", "agent");
      await add("human", "human");
      await sched.enqueue({
        person: "ann",
        kind: "chat",
        title: "chat",
        trigger: "human",
        placement: "next",
      });

      const seen: string[] = [];
      for (let i = 0; i < 5; i++) {
        const item = await runNext();
        seen.push(item.title);
        await sched.finish(item.id, { outcome: "ok" });
      }

      expect(seen).toEqual(["chat", "human", "agent", "auto", "sched"]);
    });

    it("breaks ties inside a class by position, then age", async () => {
      await add("first", "agent");
      clock.advance(1000);
      await add("second", "agent");
      clock.advance(1000);
      const third = await add("third", "agent");
      expect((await sched.next("ann"))?.title).toBe("first");
      await sched.move(third.id, { before: (await sched.next("ann"))!.id });
      expect((await sched.next("ann"))?.title).toBe("third");
    });

    it("lets an explicit priority override the class", async () => {
      await add("normal", "human");
      await sched.enqueue({
        person: "ann",
        kind: "task",
        title: "urgent",
        trigger: "agent",
        priority: 1,
      });

      expect((await sched.next("ann"))?.title).toBe("urgent");
    });

    it("keeps people independent", async () => {
      await add("ann's");
      await add("bob's", "human", { person: "bob" });
      expect((await sched.next("bob"))?.title).toBe("bob's");
      expect(await sched.next("cy")).toBeNull();
    });
  });

  describe("one active item per person", () => {
    it("returns null while an item is active and refuses a second start", async () => {
      const a = await add("a");
      const b = await add("b");
      await runNext();
      expect(await sched.next("ann")).toBeNull();
      const res = await sched.markActive(b.id);
      expect(res).toMatchObject({ started: false, reason: "busy" });
      await sched.finish(a.id, { outcome: "ok" });
      expect((await sched.next("ann"))?.id).toBe(b.id);
    });

    it("does not start an item twice", async () => {
      const a = await add("a");
      await sched.markActive(a.id);
      expect(await sched.markActive(a.id)).toMatchObject({ started: false, reason: "not_queued" });
    });

    it("counts the attempt and records a run", async () => {
      const a = await add("a");
      const res = await sched.markActive(a.id);
      expect(res.started && res.item.attempts).toBe(1);
      const done = await sched.finish(a.id, { outcome: "ok" });
      expect(done.status).toBe("done");
      expect((await store.listRuns(a.id))[0]).toMatchObject({ outcome: "ok" });
    });

    it("can hand an item back as waiting or queued", async () => {
      const a = await add("a");
      await sched.markActive(a.id);
      expect((await sched.finish(a.id, { outcome: "asked", status: "waiting" })).status).toBe(
        "waiting",
      );

      await sched.markActive(a.id).then((r) => expect(r.started).toBe(false));
    });
  });

  describe("one merge per repository", () => {
    const merge = (person: string, ref: string) =>
      sched.enqueue({
        person,
        kind: "merge",
        title: `merge ${ref}`,
        trigger: "human",
        subject: { type: "pr", ref },
      });

    it("runs one merge item per repository at a time; the others wait, whoever they belong to", async () => {
      const first = await merge("ann", "github.com/acme/shop#1");
      const second = await merge("bob", "github.com/Acme/Shop#2");
      const elsewhere = await merge("cy", "github.com/acme/ops#3");
      expect(await sched.markActive(first.id)).toMatchObject({ started: true });

      expect(await sched.next("bob")).toBeNull();
      expect(await sched.markActive(second.id)).toEqual({
        started: false,
        reason: "busy",
        detail:
          "ann is merging in the same repository (github.com/acme/shop#1); one merge runs per repository at a time.",
      });

      expect((await sched.next("cy"))?.id).toBe(elsewhere.id);
      await sched.finish(first.id, { outcome: "merged" });
      expect((await sched.next("bob"))?.id).toBe(second.id);
    });

    it("does not hold other work, and reports the person's own active item first", async () => {
      const first = await merge("ann", "github.com/acme/shop#1");
      await sched.markActive(first.id);
      const task = await add("task", "human", { person: "bob" });
      expect((await sched.next("bob"))?.id).toBe(task.id);
      await sched.markActive(task.id);
      const second = await merge("bob", "github.com/acme/shop#2");
      expect(await sched.markActive(second.id)).toMatchObject({
        reason: "busy",
        detail: "bob already has an active item.",
      });
    });
  });

  describe("human chat and move", () => {
    it("starts chat immediately when the person is idle", async () => {
      const chat = await add("chat", "human", { kind: "chat" });
      expect((await sched.next("ann"))?.id).toBe(chat.id);
    });

    it("runs chat sessions beside the active item, up to the configured number", async () => {
      const work = await add("work");
      await add("later");
      await runNext();
      const [c1, c2, c3] = [
        await add("c1", "human", { kind: "chat" }),
        await add("c2", "human", { kind: "chat" }),
        await add("c3", "human", { kind: "chat" }),
      ];

      // Sessions go first among the queued items and do not wait for the active one.
      expect(await titles()).toEqual(["c1", "c2", "c3", "later"]);
      expect((await sched.next("ann"))?.id).toBe(c1.id);
      expect(await sched.markActive(c1.id)).toMatchObject({ started: true });
      expect(await sched.markActive(c2.id)).toMatchObject({ started: true });
      expect((await store.getItem(work.id))!.status).toBe("active");

      // Two sessions run (the default); the third waits for a free one, and the work item still holds its lane.
      expect(await sched.markActive(c3.id)).toMatchObject({ started: false, reason: "busy" });
      expect(await sched.next("ann")).toBeNull();
      await sched.finish(c1.id, { outcome: "answered" });
      expect((await sched.next("ann"))?.id).toBe(c3.id);

      // The sessions do not hold the lane of work items.
      await sched.finish(work.id, { outcome: "ok" });
      await sched.markActive(c3.id);
      expect((await sched.next("ann"))?.title).toBe("later");
    });

    it("answers humans in a chat session whatever the usage", async () => {
      usage.windows = [{ name: "5h", utilization: 0.99 }];
      const chat = await add("c", "human", { kind: "chat" });
      expect((await sched.next("ann"))?.id).toBe(chat.id);
      expect(await sched.markActive(chat.id)).toMatchObject({ started: true });
    });

    it("honors the position the human chose", async () => {
      const a = await add("a", "human");
      const b = await add("b", "human");
      await add("c", "human");
      await sched.markActive(a.id);
      await add("chat-last", "human", { kind: "chat" }).then((c) =>
        sched.move(c.id, { last: true }),
      );

      expect(await titles()).toEqual(["b", "c", "chat-last"]);
      await sched.enqueue({
        person: "ann",
        kind: "chat",
        title: "chat-after-b",
        trigger: "human",
        placement: { after: b.id },
      });

      expect(await titles()).toEqual(["b", "chat-after-b", "c", "chat-last"]);
      await sched.enqueue({
        person: "ann",
        kind: "chat",
        title: "chat-next",
        trigger: "human",
        placement: "next",
      });

      expect((await titles())[0]).toBe("chat-next");
      await sched.enqueue({
        person: "ann",
        kind: "chat",
        title: "chat-end",
        trigger: "human",
        placement: "last",
      });

      expect((await titles()).at(-1)).toBe("chat-end");
    });

    it("places 'next' on an empty queue", async () => {
      await sched.enqueue({
        person: "ann",
        kind: "x",
        title: "only",
        trigger: "agent",
        placement: "next",
      });

      expect(await titles()).toEqual(["only"]);
    });

    it("moves before, after and last, and the order survives a restart", async () => {
      const a = await add("a");
      const b = await add("b");
      const c = await add("c");
      await sched.move(c.id, { before: a.id });
      expect(await titles()).toEqual(["c", "a", "b"]);
      await sched.move(c.id, { after: b.id });
      expect(await titles()).toEqual(["a", "b", "c"]);
      await sched.move(a.id, { last: true });
      expect(await titles()).toEqual(["b", "c", "a"]);

      await store.close();
      store = await h.open(() => clock.now());
      sched = build();
      expect((await sched.next("ann"))?.title).toBe("b");
      expect(await titles()).toEqual(["b", "c", "a"]);
    });

    it("lets a new item queue behind a reordered one", async () => {
      const a = await add("a");
      await add("b");
      await sched.move(a.id, { last: true });
      await add("c");
      expect(await titles()).toEqual(["b", "a", "c"]);
    });

    it("never interrupts or moves an active item, or moves across people", async () => {
      const a = await add("a");
      const b = await add("b");
      const other = await add("o", "human", { person: "bob" });
      await sched.markActive(a.id);
      await expect(sched.move(a.id, { last: true })).rejects.toThrow(/only queued/);
      await expect(sched.move(b.id, { before: other.id })).rejects.toThrow(/same queue/);
      await expect(sched.move("missing", { last: true })).rejects.toThrow(/unknown/);
      expect((await store.getItem(a.id))?.status).toBe("active");
    });
  });

  describe("loop guard", () => {
    const cycle = async (id: string) => {
      const res = await sched.markActive(id);
      if (res.started) {
        await sched.finish(id, { outcome: "ok", status: "queued" });
      }

      return res;
    };

    it("blocks an agent-triggered item after the limit and reports it", async () => {
      const a = await add("loop", "agent");
      for (let i = 0; i < 3; i++) {
        expect((await cycle(a.id)).started).toBe(true);
      }

      const res = await sched.markActive(a.id);
      expect(res).toMatchObject({ started: false, reason: "loop_guard" });
      expect(res.started === false && res.blocked?.reason).toMatch(/Loop guard/);
      expect((await store.getItem(a.id))?.status).toBe("blocked");
      expect((await store.readJournal(a.id)).at(-1)?.text).toMatch(/Blocked: Loop guard/);
    });

    it("counts automation, ignores humans and schedules, and uses a sliding hour", async () => {
      const auto = await add("auto", "automation");
      const human = await add("human", "human");
      const sch = await add("sched", "schedule");
      for (let i = 0; i < 5; i++) {
        expect((await cycle(human.id)).started).toBe(true);
        expect((await cycle(sch.id)).started).toBe(true);
      }

      for (let i = 0; i < 3; i++) {
        await cycle(auto.id);
      }

      clock.advance(61 * 60_000);
      expect((await cycle(auto.id)).started).toBe(true);
    });

    it("keeps tripped items out of next() and blocks them on tick", async () => {
      const a = await add("loop", "agent");
      const ok = await add("fine", "agent");
      for (let i = 0; i < 3; i++) {
        await cycle(a.id);
      }

      expect((await sched.next("ann"))?.id).toBe(ok.id);
      const tick = await sched.tick();
      expect(tick.blocked).toHaveLength(1);
      expect(tick.blocked[0]).toMatchObject({ code: "loop_guard", item: { id: a.id } });
      expect((await store.getItem(a.id))?.status).toBe("blocked");
      expect((await sched.tick()).blocked).toHaveLength(0);
    });

    it("block() blocks with a reason from outside", async () => {
      const a = await add("a");
      await sched.markActive(a.id);
      const n = await sched.block(a.id, "needs a human");
      expect(n).toMatchObject({ code: "manual", reason: "needs a human" });
      expect(n.item.status).toBe("blocked");
      expect((await store.listRuns(a.id))[0]).toMatchObject({ outcome: "blocked" });
      await expect(sched.block("missing", "x")).rejects.toThrow(/unknown/);
    });
  });

  describe("retry on request", () => {
    it("brings a blocked item back clean, keeping its session and journal, and logs it", async () => {
      const lines: string[] = [];
      sched = createScheduler({
        store,
        team,
        clock,
        logger: { debug() {}, info: (m) => void lines.push(m), warn() {}, error() {} },
      });

      const a = await sched.enqueue({
        person: "ann",
        kind: "task",
        title: "a",
        trigger: "agent",
        subject: { type: "ticket", ref: "ACME-1" },
      });

      await store.updateItem(a.id, { sessionId: "s1" });
      for (let i = 0; i < 3; i++) {
        const res = await sched.markActive(a.id);
        expect(res.started).toBe(true);
        await sched.finish(a.id, { outcome: "ok", status: "queued" });
      }

      expect(await sched.markActive(a.id)).toMatchObject({ reason: "loop_guard" });
      await store.updateItem(a.id, { failures: 2, notBefore: "2999-01-01T00:00:00.000Z" });

      const back = await sched.retry(a.id, { by: "dana", signal: "ticket moved" });
      expect(back).toMatchObject({
        status: "queued",
        failures: 0,
        notBefore: null,
        sessionId: "s1",
      });

      expect(await store.countLoopGuard(a.id, 60 * 60_000)).toBe(0);
      expect((await store.readJournal(a.id)).at(-1)?.text).toBe(
        "Retried on request by dana (ticket moved).",
      );

      expect(lines).toContain(`retried ${a.id} for dana on ACME-1 (signal: ticket moved)`);

      // The loop guard no longer holds it back.
      expect((await sched.markActive(a.id)).started).toBe(true);
    });

    it("does nothing for an item that is not blocked", async () => {
      const a = await add("a");
      expect(await sched.retry(a.id, { by: "dana", signal: "chat reply" })).toBeNull();
      expect(await sched.retry("missing", { by: "dana", signal: "chat reply" })).toBeNull();
      expect((await store.getItem(a.id))?.status).toBe("queued");
    });
  });

  describe("usage policy", () => {
    it("defers scheduled work, then pauses automatic work, always answering humans", async () => {
      await add("sched", "schedule");
      await add("agent", "agent");
      await add("human", "human");

      usage.windows = [{ name: "5h", utilization: 0.9 }];
      expect((await sched.next("ann"))?.title).toBe("human");
      const human = await runNext();
      await sched.finish(human.id, { outcome: "ok" });
      expect((await sched.next("ann"))?.title).toBe("agent");

      const agent = await runNext();
      await sched.finish(agent.id, { outcome: "ok" });
      expect(await sched.next("ann")).toBeNull();

      usage.windows = [{ name: "7d", utilization: 0.5 }];
      expect((await sched.next("ann"))?.title).toBe("sched");
    });

    it("pauses agents and automation but not humans at the pause threshold", async () => {
      await add("agent", "agent");
      await add("auto", "automation");
      usage.windows = [{ name: "5h", utilization: 0.96 }];
      expect(await sched.next("ann")).toBeNull();
      await add("human", "human");
      expect((await sched.next("ann"))?.title).toBe("human");
    });

    it("skips held items instead of stalling the queue", async () => {
      await add("sched", "schedule");
      await add("agent", "agent");
      usage.windows = [{ name: "5h", utilization: 0.9 }];
      expect((await sched.next("ann"))?.title).toBe("agent");
    });

    it("explains why via isPausedFor", async () => {
      usage.windows = [{ name: "5h", utilization: 0.9 }];
      expect(await sched.isPausedFor("ann", { trigger: "human" })).toBeNull();
      expect(await sched.isPausedFor("ann", { trigger: "agent" })).toBeNull();
      expect(await sched.isPausedFor("ann", { trigger: "schedule" })).toMatchObject({
        code: "usage_defer",
        reason: expect.stringContaining("90%"),
      });

      usage.windows = [{ name: "5h", utilization: 0.99 }];
      expect(await sched.isPausedFor("ann", { trigger: "agent" })).toMatchObject({
        code: "usage_pause",
      });

      expect(await sched.isPausedFor("ann", { trigger: "human" })).toBeNull();
    });

    it("refuses markActive for a held item", async () => {
      const s = await add("sched", "schedule");
      usage.windows = [{ name: "5h", utilization: 0.9 }];
      expect(await sched.markActive(s.id)).toMatchObject({ started: false, reason: "usage_defer" });
    });

    it("fails open when the usage source errors, and works without one", async () => {
      await add("sched", "schedule");
      usage.fail = true;
      expect((await sched.next("ann"))?.title).toBe("sched");
      const bare = createScheduler({ store, team, clock });
      expect((await bare.next("ann"))?.title).toBe("sched");
    });
  });

  describe("pause and resume", () => {
    it("pauses the whole team and resumes", async () => {
      await add("a");
      await add("b", "human", { person: "bob" });
      await sched.pause(undefined, "freeze");
      expect(await sched.next("ann")).toBeNull();
      expect(await sched.next("bob")).toBeNull();
      expect(await sched.isPausedFor("ann", { trigger: "human" })).toMatchObject({
        code: "paused_team",
        reason: expect.stringContaining("freeze"),
      });

      await sched.resume();
      expect((await sched.next("ann"))?.title).toBe("a");
    });

    it("pauses one person only", async () => {
      const a = await add("a");
      await add("b", "human", { person: "bob" });
      await sched.pause("ann");
      expect(await sched.next("ann")).toBeNull();
      expect((await sched.next("bob"))?.title).toBe("b");
      expect(await sched.markActive(a.id)).toMatchObject({
        started: false,
        reason: "paused_person",
      });

      await sched.resume("ann");
      expect((await sched.next("ann"))?.title).toBe("a");
    });

    it("does not interrupt the active item", async () => {
      const a = await add("a");
      await sched.markActive(a.id);
      await sched.pause("ann");
      expect((await store.getItem(a.id))?.status).toBe("active");
    });

    it("persists across a restart", async () => {
      await add("a");
      await sched.pause(undefined, "why");
      await sched.pause("ann");
      await store.close();
      store = await h.open(() => clock.now());
      sched = build();
      const state = await sched.pauseState();
      expect(state.team?.reason).toBe("why");
      expect(Object.keys(state.people)).toEqual(["ann"]);
      expect(await sched.next("ann")).toBeNull();
      await sched.resume();
      await sched.resume("ann");
      expect((await sched.next("ann"))?.title).toBe("a");
      expect(await sched.pauseState()).toEqual({ team: null, people: {} });
    });
  });

  describe("interrupted runs", () => {
    it("queues the item first, keeps its session, and counts no failure, loop or stale run", async () => {
      const a = await add("a", "agent");
      const b = await add("b", "agent");
      for (let i = 0; i < 5; i++) {
        const started = await sched.markActive(a.id);
        expect(started.started).toBe(true);
        await store.updateItem(a.id, { sessionId: "s-1" });
        await sched.interrupt(a.id, "Shut down.");
        expect((await sched.next("ann"))?.id).toBe(a.id);
      }

      expect(await store.getItem(a.id)).toMatchObject({
        status: "queued",
        failures: 0,
        notBefore: null,
        sessionId: "s-1",
      });

      expect(await store.countLoopGuard(a.id, 3_600_000)).toBe(0);
      expect((await store.listRuns(a.id)).every((r) => r.outcome === "interrupted")).toBe(true);
      expect((await store.getItem(b.id))?.status).toBe("queued");

      // The next run is the first one the guard counts, and stale detection starts from a clean slate.
      await sched.markActive(a.id);
      clock.advance(11 * 60_000);
      expect((await sched.tick()).retried.map((i) => i.id)).toEqual([a.id]);
    });

    it("goes ahead of higher-priority work already queued", async () => {
      const a = await add("a", "schedule");
      await add("b", "human");
      await sched.markActive(a.id);
      await sched.interrupt(a.id, "Shut down.");
      expect((await sched.next("ann"))?.id).toBe(a.id);
    });
  });

  describe("stale runs", () => {
    it("retries once, then blocks with a reason", async () => {
      const a = await add("a");
      await sched.markActive(a.id);
      clock.advance(9 * 60_000);
      expect(await sched.tick()).toEqual({ retried: [], released: [], blocked: [] });

      clock.advance(2 * 60_000);
      const first = await sched.tick();
      expect(first.retried.map((i) => i.id)).toEqual([a.id]);
      expect((await store.getItem(a.id))?.status).toBe("queued");
      expect((await store.listRuns(a.id))[0]).toMatchObject({ outcome: "stale" });

      const again = await runNext();
      expect(again.id).toBe(a.id);
      expect((await store.getItem(a.id))?.attempts).toBe(2);
      clock.advance(11 * 60_000);
      const second = await sched.tick();
      expect(second.blocked).toHaveLength(1);
      expect(second.blocked[0]).toMatchObject({ code: "stale", item: { status: "blocked" } });
      expect(second.blocked[0]?.reason).toMatch(/Stale again/);
    });

    it("offers a stale item again with its session", async () => {
      const a = await add("a");
      await add("b");
      await sched.markActive(a.id);
      await store.updateItem(a.id, { sessionId: "s-1" });
      clock.advance(11 * 60_000);
      await sched.tick();
      const next = await sched.next("ann");
      expect(next).toMatchObject({ id: a.id, status: "queued", sessionId: "s-1" });
    });

    it("heartbeats keep a run alive", async () => {
      const a = await add("a");
      await sched.markActive(a.id);
      for (let i = 0; i < 5; i++) {
        clock.advance(6 * 60_000);
        await sched.heartbeat(a.id);
        expect((await sched.tick()).retried).toHaveLength(0);
      }
    });

    it("forgives an earlier stale run after a good one", async () => {
      const a = await add("a");
      await sched.markActive(a.id);
      clock.advance(11 * 60_000);
      await sched.tick();
      await runNext();
      await sched.finish(a.id, { outcome: "ok", status: "queued" });
      await runNext();
      clock.advance(11 * 60_000);
      expect((await sched.tick()).retried).toHaveLength(1);
    });

    it("honors the configured threshold", async () => {
      sched = build(2);
      const a = await add("a");
      await sched.markActive(a.id);
      clock.advance(3 * 60_000);
      expect((await sched.tick()).retried).toHaveLength(1);
    });
  });

  describe("background tick", () => {
    it("ticks on the clock until stopped", async () => {
      const a = await add("a");
      await sched.markActive(a.id);
      const seen: number[] = [];
      let ticked!: () => void;
      const firstTick = new Promise<void>((resolve) => (ticked = resolve));
      sched.start((r) => {
        seen.push(r.retried.length);
        ticked();
      });

      clock.advance(11 * 60_000);
      await firstTick;
      expect(seen).toEqual([1]);

      sched.stop();
      expect(clock.pending()).toBe(0);
      clock.advance(60 * 60_000);
      expect(seen).toEqual([1]);
    });
  });

  describe("restart rebuild", () => {
    it("rebuilds queue, active item and policies from the store alone", async () => {
      await add("later", "schedule");
      await add("now", "human");
      const active = await runNext();
      await add("chat", "human", { kind: "chat" });

      await store.close();
      store = await h.open(() => clock.now());
      sched = build();
      // The chat session runs beside the active item; the next work item waits for it.
      expect((await sched.next("ann"))?.title).toBe("chat");
      await sched.finish(active.id, { outcome: "ok" });
      const chat = (await sched.next("ann"))!;
      await sched.markActive(chat.id);
      expect((await sched.next("ann"))?.title).toBe("later");
    });
  });

  describe("failure backoff", () => {
    const failRun = async (person = "ann", error = "boom") => {
      const item = await runNext(person);
      return { item, result: await sched.fail(item.id, error) };
    };

    it("holds a failed item back 1, 2 minutes and blocks on the third failure", async () => {
      const a = await add("a");
      const t0 = clock.now().getTime();

      const first = await failRun();
      expect(first.result.item).toMatchObject({ status: "queued", failures: 1 });
      expect(first.result.notBefore).toBe(new Date(t0 + 60_000).toISOString());
      expect(await sched.next("ann")).toBeNull();
      expect(await sched.markActive(a.id)).toMatchObject({ started: false, reason: "backoff" });

      clock.advance(59_000);
      expect(await sched.next("ann")).toBeNull();
      clock.advance(1_000);
      expect((await sched.next("ann"))?.id).toBe(a.id);

      const second = await failRun();
      expect(second.result.notBefore).toBe(new Date(clock.now().getTime() + 120_000).toISOString());
      expect(await sched.next("ann")).toBeNull();
      clock.advance(120_000);

      const third = await failRun("ann", "tool missing\nstack line");
      expect(third.result.blocked).toMatchObject({
        code: "failures",
        reason: "failed 3 times: tool missing",
      });

      expect(await store.getItem(a.id)).toMatchObject({
        status: "blocked",
        failures: 0,
        notBefore: null,
      });

      expect((await store.listRuns(a.id)).map((r) => r.outcome)).toEqual([
        "failed",
        "failed",
        "failed",
      ]);
    });

    it("caps the wait", async () => {
      const capped = createScheduler({
        store,
        team: {
          policies: {
            ...team.policies!,
            retry: { base_minutes: 4, cap_minutes: 5, max_failures: 5 },
          },
        },
        clock,
      });

      const a = await capped.enqueue({ person: "ann", kind: "task", title: "a", trigger: "human" });
      const waits: number[] = [];
      for (let i = 0; i < 3; i++) {
        await capped.markActive(a.id);
        const r = await capped.fail(a.id, "x");
        waits.push(Date.parse(r.notBefore!) - clock.now().getTime());
        clock.advance(5 * 60_000);
      }

      expect(waits).toEqual([4 * 60_000, 5 * 60_000, 5 * 60_000]);
    });

    it("lets other queued items run while a failed one waits", async () => {
      const a = await add("a");
      await add("b");
      await failRun();
      expect((await sched.next("ann"))?.title).toBe("b");
      const b = await runNext();
      await sched.finish(b.id, { outcome: "ok" });
      expect(await sched.next("ann")).toBeNull();
      clock.advance(60_000);
      expect((await sched.next("ann"))?.id).toBe(a.id);
    });

    it("keeps not_before across a restart", async () => {
      const a = await add("a");
      await failRun();
      await store.close();
      store = await h.open(() => clock.now());
      sched = build();
      expect(await sched.next("ann")).toBeNull();
      clock.advance(60_000);
      expect((await sched.next("ann"))?.id).toBe(a.id);
      expect(await store.getItem(a.id)).toMatchObject({ failures: 1 });
    });

    it("resets the count on success", async () => {
      await add("a");
      await failRun();
      clock.advance(60_000);
      await failRun();
      clock.advance(120_000);
      const item = await runNext();
      await sched.finish(item.id, { outcome: "ok", status: "waiting" });
      expect(await store.getItem(item.id)).toMatchObject({ failures: 0, notBefore: null });
    });

    it("does not count a plain requeue as a success", async () => {
      await add("a");
      const { item } = await failRun();
      await store.updateItem(item.id, { status: "active" });
      await sched.finish(item.id, { outcome: "again", status: "queued" });
      expect(await store.getItem(item.id)).toMatchObject({ failures: 1 });
    });

    it("tells the tick when a backoff ran out", async () => {
      await add("a");
      const { item } = await failRun();
      expect((await sched.tick()).released).toEqual([]);
      clock.advance(60_000);
      const released = (await sched.tick()).released;
      expect(released.map((i) => i.id)).toEqual([item.id]);
      expect(await store.getItem(item.id)).toMatchObject({ notBefore: null, failures: 1 });
      expect((await sched.tick()).released).toEqual([]);
    });
  });
});
