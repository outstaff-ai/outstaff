import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TeamConfig } from "@outstaff/core";
import { manualClock } from "#/clock.js";
import { findItem } from "#/link/item.js";
import { createScheduler } from "#/scheduler/index.js";
import { openStore, type Store } from "#/store/index.js";
import { schedulerWorkSource } from "#/work-source.js";

const team = {
  people: [],
  policies: {
    agent_loop_guard: { max_runs_per_item_per_hour: 12 },
    usage: { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 },
    retry: { base_minutes: 1, cap_minutes: 30, max_failures: 2 },
  },
} as unknown as Pick<TeamConfig, "people" | "humans" | "policies">;

describe("which runtime and model ran an item", () => {
  let store: Store;
  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  async function finished(person: string, on: { runtime: string; model: string }, seen?: string) {
    const scheduler = createScheduler({ store, team, clock: manualClock() });
    const source = schedulerWorkSource({ scheduler, store, team });
    const queued = await scheduler.enqueue({ person, kind: "task", title: "t", trigger: "human" });
    const offer = await source.next(person);
    await source.accept(person, queued.id, on);
    await source.setSession(person, queued.id, `s-${person}`, seen);
    await source.handBack(person, queued.id, { summary: "ok", links: [], status: "done" });

    return (await findItem(store, offer!.workItem.id))!.item.runs;
  }

  it("tells Kofi on one runtime and model from Sam on another runtime and model", async () => {
    const kofi = await finished("kofi", { runtime: "claude", model: "opus" }, "claude-opus-4-1");
    const sam = await finished("sam", { runtime: "scripted", model: "sonnet" });

    expect(kofi).toEqual([
      expect.objectContaining({ outcome: "ok", runtime: "claude", model: "claude-opus-4-1" }),
    ]);

    expect(sam).toEqual([
      expect.objectContaining({ outcome: "ok", runtime: "scripted", model: "sonnet" }),
    ]);
  });

  it("keeps the configured model when the runtime does not name one", async () => {
    const runs = await finished("kofi", { runtime: "claude", model: "opus" });
    expect(runs[0]).toMatchObject({ runtime: "claude", model: "opus" });
  });

  it("leaves a run that was never accepted without a runtime", async () => {
    const scheduler = createScheduler({ store, team, clock: manualClock() });
    const source = schedulerWorkSource({ scheduler, store, team });
    const queued = await scheduler.enqueue({
      person: "sam",
      kind: "task",
      title: "t",
      trigger: "human",
    });

    await source.next("sam");
    expect((await findItem(store, queued.id))!.item.runs[0]).toMatchObject({
      runtime: null,
      model: null,
    });
  });
});
