import type { TeamConfig } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { COALESCE_SUBJECT } from "#/scheduler/enqueue.js";
import { createScheduler } from "#/scheduler/scheduler.js";
import type { Coalesce, EnqueueInput } from "#/scheduler/types.js";
import { openStore } from "#/store/open.js";
import type { Store, WorkItem } from "#/store/types.js";

const team = {} as Pick<TeamConfig, "policies">;
const START = "2030-01-01T00:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(START) + seconds * 1000).toISOString();

let store: Store | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

async function setup() {
  const clock = manualClock(START);
  store = await openStore("sqlite::memory:", { now: () => clock.now() });
  const released: string[] = [];
  const scheduler = createScheduler({
    store,
    team,
    clock,
    onReleased: (person) => void released.push(person),
  });

  const folds: string[] = [];
  const wake = (seconds: number, extra: Partial<Coalesce> = {}): EnqueueInput => ({
    person: "sam",
    kind: "review_feedback",
    title: "review feedback: PR #9",
    trigger: "human",
    subject: { type: "pr", ref: "acme/shop#9" },
    coalesce: {
      key: "sam pr acme/shop#9",
      at: at(seconds),
      windowMs: 60_000,
      fold: async (item) => void folds.push(item.id),
      ...extra,
    },
  });

  return { clock, store, scheduler, released, folds, wake };
}

describe("coalescing in the scheduler's enqueue", () => {
  it("holds the first wake's item for the window and folds the wakes inside it into that item", async () => {
    const { store: s, scheduler, folds, wake } = await setup();
    const first = await scheduler.enqueue(wake(0));
    expect(first.notBefore).toBe(at(60));
    expect(await scheduler.markActive(first.id)).toMatchObject({
      started: false,
      reason: "backoff",
      detail: `Held until ${at(60)}, so wakes that come close together run as one.`,
    });

    expect(await scheduler.next("sam")).toBeNull();
    expect((await scheduler.enqueue(wake(20))).id).toBe(first.id);
    expect((await scheduler.enqueue(wake(59))).id).toBe(first.id);
    expect(folds).toEqual([first.id, first.id]);
    expect(await s.listItems({ person: "sam" })).toHaveLength(1);

    // At the window's end a wake is a run of its own.
    const later = await scheduler.enqueue(wake(60));
    expect(later.id).not.toBe(first.id);
    expect((await s.getSubject(COALESCE_SUBJECT, "sam pr acme/shop#9"))?.data).toEqual({
      itemId: later.id,
      until: at(120),
    });
  });

  it("releases the held item when its window closes, and tells the person", async () => {
    const { clock, store: s, scheduler, released, wake } = await setup();
    const first = await scheduler.enqueue(wake(0));
    clock.advance(59_000);
    expect(released).toEqual([]);
    clock.advance(1_000);
    await scheduler.tick();
    expect(released).toEqual(["sam"]);
    expect((await s.getItem(first.id))?.notBefore).toBeNull();
    expect(await scheduler.next("sam")).toMatchObject({ id: first.id });
  });

  it("leaves an item that started, or was held again, to what changed it", async () => {
    const { clock, store: s, scheduler, released, wake } = await setup();
    const started = await scheduler.enqueue(wake(0));
    const other = await scheduler.enqueue(wake(0, { key: "other" }));
    await s.updateItem(started.id, { status: "active" });
    await s.updateItem(other.id, { notBefore: at(600) });
    clock.advance(60_000);
    await scheduler.tick();
    expect(released).toEqual([]);
    expect((await s.getItem(other.id))?.notBefore).toBe(at(600));
  });

  it("does not fold into an item that is no longer queued", async () => {
    const { store: s, scheduler, folds, wake } = await setup();
    const first = await scheduler.enqueue(wake(0));
    await s.updateItem(first.id, { status: "active" });
    expect((await scheduler.enqueue(wake(10))).id).not.toBe(first.id);
    expect(folds).toEqual([]);
  });

  it("holds and folds nothing with a window of 0, and holds no wake whose window has passed", async () => {
    const { clock, store: s, scheduler, folds, wake } = await setup();
    const a = await scheduler.enqueue(wake(0, { windowMs: 0 }));
    const b = await scheduler.enqueue(wake(0, { windowMs: 0 }));
    expect([a.notBefore, b.notBefore, a.id === b.id]).toEqual([null, null, false]);

    clock.advance(120_000);
    const late = await scheduler.enqueue(wake(0, { key: "late" }));
    expect(late.notBefore).toBeNull();
    // An event that happened inside the window still folds, though the item was never held.
    expect((await scheduler.enqueue(wake(30, { key: "late" }))).id).toBe(late.id);
    expect(folds).toEqual([late.id]);
    expect(await s.listItems({ person: "sam" })).toHaveLength(3);
  });

  it("stops releasing holds when stopped; the tick releases them after a restart", async () => {
    const { clock, store: s, scheduler, released, wake } = await setup();
    const first = await scheduler.enqueue(wake(0));
    scheduler.stop();
    clock.advance(60_000);
    expect(released).toEqual([]);
    const tick = await scheduler.tick();
    expect(tick.released.map((i: WorkItem) => i.id)).toEqual([first.id]);
    expect((await s.getItem(first.id))?.notBefore).toBeNull();
  });

  it("still places an item that is not coalesced", async () => {
    const { scheduler } = await setup();
    const base = { person: "sam", kind: "assigned", title: "t", trigger: "human" } as const;
    const a = await scheduler.enqueue(base);
    const b = await scheduler.enqueue({ ...base, placement: "next" });
    const c = await scheduler.enqueue({ ...base, placement: { before: a.id } });
    const d = await scheduler.enqueue({ ...base, placement: "last" });
    expect((await scheduler.next("sam"))?.id).toBe(b.id);
    expect([a, c, d].every((i) => i.notBefore === null)).toBe(true);
  });
});
