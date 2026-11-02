import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { createScheduler } from "#/scheduler/scheduler.js";
import type { Scheduler } from "#/scheduler/types.js";
import { openStore } from "#/store/open.js";
import type { Store, WorkItem } from "#/store/types.js";

describe("scheduler: the start-time check", () => {
  let store: Store;
  let sched: Scheduler;
  let stopped: Set<string>;

  beforeEach(async () => {
    const clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    stopped = new Set();
    sched = createScheduler({
      store,
      team: {},
      clock,
      stopped: async (item: WorkItem) =>
        stopped.has(item.id) ? `Canceled: ${item.title} was closed.` : undefined,
    });
  });

  afterEach(async () => {
    sched.stop();
    await store.close();
  });

  const add = (title: string) =>
    sched.enqueue({ person: "sam", kind: "assigned", title, trigger: "human" });

  it("cancels a stopped item instead of offering it, and offers the one after", async () => {
    const [first, second] = [await add("ACME-1"), await add("ACME-2")];
    stopped.add(first.id);

    expect((await sched.next("sam"))?.id).toBe(second.id);
    expect((await store.getItem(first.id))?.status).toBe("canceled");
    expect((await store.readJournal(first.id)).map((j) => [j.author, j.text])).toEqual([
      ["scheduler", "Canceled: ACME-1 was closed."],
    ]);
  });

  it("refuses to start an item stopped since it was picked, and cancels it", async () => {
    const item = await add("ACME-1");
    expect((await sched.next("sam"))?.id).toBe(item.id);
    stopped.add(item.id);

    expect(await sched.markActive(item.id)).toEqual({
      started: false,
      reason: "stopped",
      detail: "Canceled: ACME-1 was closed.",
    });

    expect((await store.getItem(item.id))?.status).toBe("canceled");
    expect(await sched.next("sam")).toBeNull();
  });

  it("starts items as before without a check", async () => {
    const clock = manualClock();
    const plain = createScheduler({ store, team: {}, clock });
    const item = await add("ACME-1");
    expect(await plain.markActive(item.id)).toMatchObject({ started: true });
  });
});
