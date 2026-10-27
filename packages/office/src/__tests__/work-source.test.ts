import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TeamConfig } from "@outstaff/core";
import { manualClock } from "../clock.js";
import type { ManualClock } from "../types.js";
import { createScheduler } from "../scheduler/index.js";
import type { BlockNotice } from "../scheduler/types.js";
import { openStore } from "../store/open.js";
import type { Store } from "../store/types.js";
import { schedulerWorkSource } from "../work-source.js";

const team = {
  people: [],
  policies: {
    agent_loop_guard: { max_runs_per_item_per_hour: 12 },
    usage: { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 },
    retry: { base_minutes: 1, cap_minutes: 30, max_failures: 2 },
  },
} as unknown as Pick<TeamConfig, "people" | "humans" | "policies">;

describe("work source: failed runs", () => {
  let store: Store;
  let clock: ManualClock;
  let blocked: BlockNotice[];

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite://:memory:", { now: () => clock.now() });
    blocked = [];
  });

  afterEach(async () => {
    await store.close();
  });

  const build = () => {
    const scheduler = createScheduler({ store, team, clock });
    const source = schedulerWorkSource({
      scheduler,
      store,
      team,
      onBlocked: (b) => void blocked.push(b),
    });

    return { scheduler, source };
  };

  it("backs off, offers other work, then blocks and notifies after the limit", async () => {
    const { scheduler, source } = build();
    const a = await scheduler.enqueue({
      person: "ann",
      kind: "task",
      title: "a",
      trigger: "human",
    });

    await scheduler.enqueue({ person: "ann", kind: "task", title: "b", trigger: "human" });

    expect((await source.next("ann"))?.workItem.id).toBe(a.id);
    await source.fail("ann", a.id, "runtime crashed\nat line 3");
    expect(blocked).toEqual([]);

    const b = await source.next("ann");
    expect(b?.workItem.title).toBe("b");
    await source.handBack("ann", b!.workItem.id, { summary: "done", links: [], status: "done" });
    expect(await source.next("ann")).toBeUndefined();

    clock.advance(60_000);
    expect((await source.next("ann"))?.workItem.id).toBe(a.id);
    await source.fail("ann", a.id, "runtime crashed\nat line 3");

    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      code: "failures",
      reason: "failed 2 times: runtime crashed",
      item: { id: a.id, status: "blocked" },
    });
  });
});

describe("work source: a chat session beside running work", () => {
  it("offers the running work's subjects and journal with the session", async () => {
    const clock = manualClock();
    const store = await openStore("sqlite://:memory:", { now: () => clock.now() });
    const scheduler = createScheduler({ store, team, clock });
    const source = schedulerWorkSource({ scheduler, store, team });

    const work = await scheduler.enqueue({
      person: "ann",
      kind: "assigned",
      title: "assigned: ACME-1",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    await source.next("ann");
    await store.appendJournal(work.id, "ann", "Tried the index.");

    const chat = await scheduler.enqueue({
      person: "ann",
      kind: "chat",
      title: "Chat: how is it going?",
      trigger: "human",
      subject: { type: "chat", ref: "D1:t1" },
    });

    await store.upsertSubject("chat_origin", chat.id, {
      channel: "D1",
      thread: "t1",
      requester: { id: "U1" },
      awaitingPlacement: false,
      claimed: [],
      about: { id: work.id, title: work.title, state: "running" },
    });

    await store.appendJournal(chat.id, "office", "Dana replied in chat.");

    const offer = await source.next("ann");
    expect(offer?.workItem.id).toBe(chat.id);
    expect(offer?.workItem.origin?.about).toEqual({
      id: work.id,
      title: work.title,
      state: "running",
    });

    expect(offer?.context.subjects.map((s) => `${s.type} ${s.ref}`)).toContain("ticket ACME-1");
    expect(offer?.context.journal.map((j) => j.text)).toEqual([
      "Tried the index.",
      "Dana replied in chat.",
    ]);

    await store.close();
  });
});

describe("work source: a run cut short by a shutdown", () => {
  let store: Store;
  let clock: ManualClock;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite://:memory:", { now: () => clock.now() });
  });

  afterEach(async () => {
    await store.close();
  });

  it("queues the item first and offers it again with its session, without a failure or a loop count", async () => {
    const scheduler = createScheduler({ store, team, clock });
    const handedBack: string[] = [];
    const source = schedulerWorkSource({
      scheduler,
      store,
      team,
      onHandedBack: async (_item, result) => void handedBack.push(result.status),
    });

    const a = await scheduler.enqueue({
      person: "ann",
      kind: "task",
      title: "a",
      trigger: "agent",
    });

    await scheduler.enqueue({ person: "ann", kind: "task", title: "b", trigger: "agent" });

    const first = await source.next("ann");
    expect(first?.workItem.id).toBe(a.id);
    expect(first?.interrupted).toBeUndefined();
    await source.setSession("ann", a.id, "s-1");
    await source.handBack("ann", a.id, { summary: "stopped", links: [], status: "interrupted" });

    expect(await store.getItem(a.id)).toMatchObject({
      status: "queued",
      failures: 0,
      sessionId: "s-1",
      notBefore: null,
    });

    expect(await store.countLoopGuard(a.id, 3_600_000)).toBe(0);
    expect((await store.listRuns(a.id))[0]).toMatchObject({ outcome: "interrupted" });

    const again = await source.next("ann");
    expect(again?.workItem.id).toBe(a.id);
    expect(again).toMatchObject({ sessionId: "s-1", interrupted: true });
    expect(handedBack).toEqual(["interrupted"]);
  });
});
