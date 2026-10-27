import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "#/store/index.js";
import { countActivity, DEFAULT_WINDOWS } from "#/link/activity.js";
import { record, trace } from "./support.js";

const NOW = new Date(Date.UTC(2026, 9, 5, 12));
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

describe("countActivity", () => {
  let store: Store;
  let clock = NOW.getTime();
  beforeEach(async () => {
    store = await openStore("sqlite::memory:", { now: () => new Date(clock) });
  });

  afterEach(async () => {
    await store.close();
  });

  it("counts events that happened and items created in each window, the last hour and day by default", async () => {
    await record(store, trace("old", minutesAgo(25 * 60)));
    await record(store, trace("day", minutesAgo(5 * 60)));
    await record(store, trace("hour", minutesAgo(30)));
    clock = NOW.getTime() - 3 * 3_600_000;
    await store.enqueue({ person: "sam", kind: "assigned", title: "earlier", trigger: "human" });
    clock = NOW.getTime() - 60_000;
    await store.enqueue({ person: "sam", kind: "assigned", title: "now", trigger: "human" });

    expect(DEFAULT_WINDOWS).toEqual([3600, 86400]);
    expect(await countActivity(store, NOW)).toEqual({
      at: NOW.toISOString(),
      windows: [
        { seconds: 3600, since: minutesAgo(60), events: 1, items: 1 },
        { seconds: 86400, since: minutesAgo(24 * 60), events: 2, items: 2 },
      ],
    });

    expect((await countActivity(store, NOW, [60, 7 * 86400])).windows).toMatchObject([
      { seconds: 60, events: 0, items: 0 },
      { seconds: 7 * 86400, events: 3, items: 2 },
    ]);
  });
});
