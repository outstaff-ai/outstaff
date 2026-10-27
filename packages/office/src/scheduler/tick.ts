import type { WorkItem } from "#/store/types.js";
import type { SchedulerDeps } from "./checks.types.js";
import { staleVerdict, trailingStale } from "./policy.js";
import type { TickResult } from "./types.js";

const minutesOf = (ms: number) => Math.round(ms / 60_000);

/** A stale run's first time: the open run ends as stale and the item goes back to the queue. */
async function retryStale(deps: SchedulerDeps, item: WorkItem, openRun: string | undefined) {
  const { store, log, staleMs } = deps;
  if (openRun) {
    await store.finishRun(openRun, {
      outcome: "stale",
      error: `No heartbeat for ${minutesOf(staleMs)} minutes.`,
    });
  }

  const requeued = await store.updateItem(item.id, { status: "queued" });
  await store.appendJournal(item.id, "scheduler", "Run went stale; retrying once.");
  log.warn("stale run requeued", { item: item.id });
  return requeued;
}

/** Active items without a heartbeat: retried once, blocked when the retry went stale too. */
async function sweepStale(deps: SchedulerDeps, result: TickResult) {
  const { store, clock, staleMs } = deps;
  const now = clock.now();
  for (const item of await store.listItems({ status: "active" })) {
    const runs = await store.listRuns(item.id);
    const verdict = staleVerdict({
      lastActivity: new Date(item.updatedAt),
      now,
      staleMs,
      trailingStaleRuns: trailingStale(runs.map((r) => r.outcome)),
    });

    if (verdict === "retry") {
      result.retried.push(
        await retryStale(deps, item, runs.findLast((r) => r.finishedAt === null)?.id),
      );
    } else if (verdict === "block") {
      const reason = `Stale again: no heartbeat for ${minutesOf(staleMs)} minutes on the retry.`;
      result.blocked.push(await deps.checks.blockItem(item, reason, "stale"));
    }
  }
}

/** Backoff that ran out: clear it so the person is told there is work again. */
async function releaseBackoffs(deps: SchedulerDeps, result: TickResult) {
  for (const item of await deps.store.listItems({ status: "queued" })) {
    if (item.notBefore !== null && !deps.checks.backingOff(item)) {
      result.released.push(await deps.store.updateItem(item.id, { notBefore: null }));
    }
  }
}

/** Surface loop-guard trips even when nobody asks for the item. */
async function sweepLoopGuard(deps: SchedulerDeps, result: TickResult) {
  const { guardTripped, blockItem, queuedOf } = deps.checks;
  const people = new Set((await deps.store.listItems({ status: "queued" })).map((i) => i.person));
  for (const person of people) {
    for (const item of await queuedOf(person)) {
      const tripped = await guardTripped(item);
      if (tripped) {
        result.blocked.push(await blockItem(item, tripped, "loop_guard"));
      }
    }
  }
}

/** Housekeeping: stale runs, ran-out backoffs and a loop-guard sweep. */
export async function runTick(deps: SchedulerDeps): Promise<TickResult> {
  const result: TickResult = { retried: [], released: [], blocked: [] };
  await sweepStale(deps, result);
  await releaseBackoffs(deps, result);
  await sweepLoopGuard(deps, result);
  return result;
}
