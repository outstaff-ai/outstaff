import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TeamConfig } from "@outstaff/core";
import { manualClock, type ManualClock } from "./clock.js";
import { createScheduler } from "./scheduler/index.js";
import type { BlockNotice } from "./scheduler/scheduler.js";
import { openStore } from "./store/open.js";
import type { Store } from "./store/types.js";
import { schedulerWorkSource } from "./work-source.js";

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
