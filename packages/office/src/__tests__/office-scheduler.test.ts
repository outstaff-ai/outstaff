import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manualClock } from "#/clock.js";
import { notifyingScheduler } from "#/office-scheduler.js";
import { createScheduler } from "#/scheduler/scheduler.js";
import type { Scheduler } from "#/scheduler/types.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/index.js";

describe("notifyingScheduler", () => {
  let store: Store;
  let scheduler: Scheduler;
  let told: string[];
  let clock: ReturnType<typeof manualClock>;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    told = [];
    scheduler = notifyingScheduler({
      scheduler: createScheduler({ store, team: {}, clock }),
      store,
      workState: {} as WorkState,
      notify: (person) => told.push(person),
    });
  });

  afterEach(async () => {
    scheduler.stop();
    await store.close();
  });

  const merge = (person: string, ref: string) =>
    scheduler.enqueue({
      person,
      kind: "merge",
      title: `merge ${ref}`,
      trigger: "human",
      subject: { type: "pr", ref },
    });

  const started = async (person: string, ref: string) => {
    const item = await merge(person, ref);
    await scheduler.markActive(item.id);
    return item;
  };

  it("tells the people whose merges wait in the repository when a merge ends, however it ends", async () => {
    const first = await started("ann", "github.com/acme/shop#1");
    await merge("bob", "github.com/acme/shop#2");
    await merge("cy", "github.com/acme/ops#3");
    told = [];
    await scheduler.finish(first.id, { outcome: "merged" });
    expect(told).toEqual(["bob"]);

    for (const end of [
      (id: string) => scheduler.fail(id, "crashed"),
      (id: string) => scheduler.interrupt(id, "shut down"),
      (id: string) => scheduler.block(id, "stuck"),
    ]) {
      const again = await started("dee", "github.com/acme/shop#4");
      told = [];
      await end(again.id);
      expect(told).toContain("bob");
    }
  });

  it("tells them when the tick retries or blocks a stale merge, and still reports the tick", async () => {
    const first = await started("ann", "github.com/acme/shop#1");
    await merge("bob", "github.com/acme/shop#2");
    const ticks: unknown[] = [];
    scheduler.start((r) => ticks.push(r));
    told = [];
    clock.advance(11 * 60_000);
    await vi.waitFor(() => expect(ticks).toHaveLength(1));
    expect(told.toSorted()).toEqual(["ann", "bob"]);
    expect((await store.getItem(first.id))?.status).toBe("queued");
    scheduler.stop();
    scheduler.start();
    clock.advance(60_000);
    await vi.waitFor(async () =>
      expect((await store.listItems({ status: "queued" })).length).toBe(2),
    );
  });

  it("tells no one more when another kind of item ends", async () => {
    const task = await scheduler.enqueue({
      person: "ann",
      kind: "task",
      title: "task",
      trigger: "human",
    });

    await merge("bob", "github.com/acme/shop#2");
    await scheduler.markActive(task.id);
    told = [];
    await scheduler.finish(task.id, { outcome: "ok" });
    expect(told).toEqual([]);
  });
});
