import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import type { ManualClock } from "#/types.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import { workStatus } from "#/work-status.js";

describe("work status", () => {
  let store: Store;
  let clock: ManualClock;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite://:memory:", { now: () => clock.now() });
  });

  afterEach(async () => {
    await store.close();
  });

  const item = (person: string, title: string) =>
    store.enqueue({ person, kind: "task", title, trigger: "human" });

  it("gives the state of the person's own items, in the order asked", async () => {
    const queued = await item("marcus", "queued");
    const done = await item("marcus", "done");
    await store.updateItem(done.id, { status: "done" });
    const canceled = await item("marcus", "canceled");
    await store.updateItem(canceled.id, { status: "canceled" });

    const { status } = workStatus(store);

    expect(await status("marcus", [done.id, queued.id, canceled.id])).toEqual([
      { workItemId: done.id, state: "done", updatedAt: expect.any(String) },
      { workItemId: queued.id, state: "queued", updatedAt: expect.any(String) },
      { workItemId: canceled.id, state: "canceled", updatedAt: expect.any(String) },
    ]);
  });

  it("gives when each of the person's own items last changed", async () => {
    const blocked = await item("marcus", "blocked");
    clock.advance(60_000);
    await store.updateItem(blocked.id, { status: "blocked" });
    const changed = new Date(clock.now()).toISOString();
    clock.advance(60_000);

    const { status } = workStatus(store);

    expect(await status("marcus", [blocked.id])).toEqual([
      { workItemId: blocked.id, state: "blocked", updatedAt: changed },
    ]);
  });

  it("says only that an item is not theirs when it belongs to someone else", async () => {
    const reassigned = await item("priya", "reassigned");
    await store.updateItem(reassigned.id, { status: "blocked" });

    const { status } = workStatus(store);

    expect(await status("marcus", [reassigned.id])).toEqual([
      { workItemId: reassigned.id, state: "not_yours" },
    ]);
  });

  it("says an item is unknown when the office has none with that id", async () => {
    const { status } = workStatus(store);

    expect(await status("marcus", ["nope"])).toEqual([{ workItemId: "nope", state: "unknown" }]);
  });
});
