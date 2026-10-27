import type { SchedulerDeps } from "./checks.types.js";
import { staleVerdict, trailingStale } from "./policy.js";
import type { TickResult } from "./types.js";

/** Housekeeping: stale runs, ran-out backoffs and a loop-guard sweep. */
export async function runTick(deps: SchedulerDeps): Promise<TickResult> {
  const { store, clock, log, staleMs } = deps;
  const { backingOff, guardTripped, blockItem, queuedOf } = deps.checks;
  const result: TickResult = { retried: [], released: [], blocked: [] };
  const now = clock.now();

  for (const item of await store.listItems({ status: "active" })) {
    const runs = await store.listRuns(item.id);
    const verdict = staleVerdict({
      lastActivity: new Date(item.updatedAt),
      now,
      staleMs,
      trailingStaleRuns: trailingStale(runs.map((r) => r.outcome)),
    });

    if (verdict === "ok") {
      continue;
    }

    const minutes = Math.round(staleMs / 60_000);
    const run = runs.findLast((r) => r.finishedAt === null);
    if (verdict === "retry") {
      if (run) {
        await store.finishRun(run.id, {
          outcome: "stale",
          error: `No heartbeat for ${minutes} minutes.`,
        });
      }

      const requeued = await store.updateItem(item.id, { status: "queued" });
      await store.appendJournal(item.id, "scheduler", "Run went stale; retrying once.");
      log.warn("stale run requeued", { item: item.id });
      result.retried.push(requeued);
    } else {
      result.blocked.push(
        await blockItem(
          item,
          `Stale again: no heartbeat for ${minutes} minutes on the retry.`,
          "stale",
        ),
      );
    }
  }

  // Backoff that ran out: clear it so the person is told there is work again.
  for (const item of await store.listItems({ status: "queued" })) {
    if (item.notBefore !== null && !backingOff(item)) {
      result.released.push(await store.updateItem(item.id, { notBefore: null }));
    }
  }

  // Surface loop-guard trips even when nobody asks for the item.
  const people = new Set((await store.listItems({ status: "queued" })).map((i) => i.person));
  for (const person of people) {
    for (const item of await queuedOf(person)) {
      const tripped = await guardTripped(item);
      if (tripped) {
        result.blocked.push(await blockItem(item, tripped, "loop_guard"));
      }
    }
  }

  return result;
}
