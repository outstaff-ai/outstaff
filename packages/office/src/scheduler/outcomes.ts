import type { WorkItem } from "../store/types.js";
import type { SchedulerDeps } from "./checks.types.js";
import { INTERRUPTED } from "./constants.js";
import { backoffMs, orderQueue } from "./policy.js";
import type { BlockNotice, FailResult, FinishInput, RetryRequest } from "./types.js";

export async function finishItem(
  deps: SchedulerDeps,
  itemId: string,
  input: FinishInput,
): Promise<WorkItem> {
  const { store } = deps;
  const { openRun } = deps.checks;
  const run = await openRun(itemId);
  if (run) {
    await store.finishRun(run.id, {
      outcome: input.outcome,
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.usage === undefined ? {} : { usage: input.usage }),
    });
  }

  const status = input.status ?? "done";
  // Finishing the work is a success; a plain requeue is not.
  return store.updateItem(itemId, {
    status,
    ...(status === "queued" ? {} : { failures: 0, notBefore: null }),
  });
}

export async function interruptItem(
  deps: SchedulerDeps,
  itemId: string,
  outcome: string,
): Promise<WorkItem> {
  const { store, log } = deps;
  const { openRun, queuedOf, applyMove } = deps.checks;
  const run = await openRun(itemId);
  if (run) {
    await store.finishRun(run.id, { outcome: INTERRUPTED, error: outcome });
  }

  await store.forgetLatestLoopGuard(itemId);
  const item = await store.updateItem(itemId, { status: "queued", notBefore: null });
  const first = orderQueue(await queuedOf(item.person)).find((i) => i.id !== itemId);
  if (first) {
    await applyMove(itemId, { before: first.id });
  }

  await store.appendJournal(itemId, "scheduler", "Run interrupted by a shutdown; queued first.");

  log.info("work item interrupted; queued first", { item: itemId, person: item.person });
  return (await store.getItem(itemId)) ?? item;
}

export async function failItem(
  deps: SchedulerDeps,
  itemId: string,
  error: string,
): Promise<FailResult> {
  const { store, clock, log, retry } = deps;
  const { openRun, blockItem } = deps.checks;
  const item = await store.getItem(itemId);
  if (!item) {
    throw new Error(`unknown work item: ${itemId}`);
  }

  const run = await openRun(itemId);
  if (run) {
    await store.finishRun(run.id, { outcome: "failed", error });
  }

  const failures = item.failures + 1;
  if (failures >= retry.max_failures) {
    const firstLine = error.split("\n", 1)[0]?.trim() || "unknown error";
    const blocked = await blockItem(item, `failed ${failures} times: ${firstLine}`, "failures");

    // A human who unblocks the item starts it with a clean count.
    const reset = await store.updateItem(itemId, { failures: 0, notBefore: null });
    return { item: reset, blocked: { ...blocked, item: reset } };
  }

  const notBefore = new Date(clock.now().getTime() + backoffMs(failures, retry)).toISOString();

  const updated = await store.updateItem(itemId, { status: "queued", failures, notBefore });
  await store.appendJournal(
    itemId,
    "scheduler",
    `Failed ${failures} of ${retry.max_failures} times; retrying after ${notBefore}.`,
  );

  log.warn("work item failed; backing off", { item: itemId, failures, notBefore });
  return { item: updated, notBefore };
}

export async function blockById(
  deps: SchedulerDeps,
  itemId: string,
  reason: string,
): Promise<BlockNotice> {
  const { store } = deps;
  const { blockItem } = deps.checks;
  const item = await store.getItem(itemId);
  if (!item) {
    throw new Error(`unknown work item: ${itemId}`);
  }

  return blockItem(item, reason, "manual");
}

export async function retryItem(
  deps: SchedulerDeps,
  itemId: string,
  request: RetryRequest,
): Promise<WorkItem | null> {
  const { store, log } = deps;
  const item = await store.getItem(itemId);
  if (item?.status !== "blocked") {
    return null;
  }

  await store.clearLoopGuard(itemId);
  const queued = await store.updateItem(itemId, {
    status: "queued",
    failures: 0,
    notBefore: null,
  });

  await store.appendJournal(
    itemId,
    "scheduler",
    `Retried on request by ${request.by} (${request.signal}).`,
  );

  log.info(
    `retried ${itemId} for ${request.by} on ${item.subject?.ref ?? item.title} (signal: ${request.signal})`,
    { item: itemId, person: item.person, by: request.by, signal: request.signal },
  );

  return queued;
}
