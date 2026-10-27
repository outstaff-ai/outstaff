import type { Store, WorkItem } from "#/store/types.js";
import type { Checks, SchedulerDeps } from "./checks.types.js";
import { orderQueue, priorityFor } from "./policy.js";
import type { Coalesce, EnqueueInput, Placement } from "./types.js";

/** The open coalescing window of each key: the item it folds into, and when it closes. Keyed by `Coalesce.key`. */
export const COALESCE_SUBJECT = "wake_coalesce";

interface CoalesceWindow {
  itemId: string;
  until: string;
}

/** The held item a wake folds into: one whose window is still open at the wake's time and that has not started. */
async function openWindow(store: Store, c: Coalesce): Promise<WorkItem | undefined> {
  if (c.windowMs <= 0) {
    return undefined;
  }

  const open = (await store.getSubject(COALESCE_SUBJECT, c.key))?.data as
    | CoalesceWindow
    | undefined;

  if (!open || Date.parse(c.at) >= Date.parse(open.until)) {
    return undefined;
  }

  const item = await store.getItem(open.itemId);
  return item?.status === "queued" ? item : undefined;
}

/** Opens the item's window and holds it until the window closes, unless that time has passed already. */
async function hold(deps: SchedulerDeps, item: WorkItem, c: Coalesce): Promise<WorkItem> {
  if (c.windowMs <= 0) {
    return item;
  }

  const until = new Date(Date.parse(c.at) + c.windowMs).toISOString();
  await deps.store.upsertSubject(COALESCE_SUBJECT, c.key, {
    itemId: item.id,
    until,
  } satisfies CoalesceWindow);

  if (Date.parse(until) <= deps.clock.now().getTime()) {
    return item;
  }

  return deps.store.updateItem(item.id, { notBefore: until });
}

async function place(checks: Checks, item: WorkItem, placement: Placement): Promise<void> {
  if (placement === "last") {
    return checks.applyMove(item.id, { last: true });
  }

  if (placement !== "next") {
    return checks.applyMove(item.id, placement);
  }

  const first = orderQueue(await checks.queuedOf(item.person)).find((i) => i.id !== item.id);
  if (first) {
    await checks.applyMove(item.id, { before: first.id });
  }
}

/** Creates the item, held for its coalescing window if it has one. */
async function create(
  deps: SchedulerDeps,
  input: Omit<EnqueueInput, "placement" | "init">,
): Promise<WorkItem> {
  const { coalesce, ...rest } = input;
  const created = await deps.store.enqueue({
    ...rest,
    priority: input.priority ?? priorityFor(input.trigger, input.kind),
  });

  return coalesce ? hold(deps, created, coalesce) : created;
}

/**
 * Queues an item, or folds it into the held item of the same coalescing key. `held` hears of an item held for its
 * window, so it can be released on time.
 */
export async function enqueueItem(
  deps: SchedulerDeps,
  input: EnqueueInput,
  held: (item: WorkItem) => void,
): Promise<WorkItem> {
  const { store } = deps;
  const { placement, init, ...rest } = input;
  const into = rest.coalesce ? await openWindow(store, rest.coalesce) : undefined;
  if (into) {
    await rest.coalesce!.fold(into);
    return into;
  }

  const created = await create(deps, rest);
  if (created.notBefore !== null) {
    held(created);
  }

  await init?.(created);
  if (placement !== undefined) {
    await place(deps.checks, created, placement);
  }

  // Placing it moved it; it was created in this same exclusive step, so it is there.
  return (await store.getItem(created.id))!;
}

/** The hold of an item ran out: it can be offered, unless it started, moved on or was held again since. */
export async function releaseHold(
  deps: SchedulerDeps,
  item: WorkItem,
  onReleased: ((person: string) => void) | undefined,
): Promise<void> {
  const now = await deps.store.getItem(item.id);
  if (now?.status !== "queued" || now.notBefore !== item.notBefore) {
    return;
  }

  await deps.store.updateItem(item.id, { notBefore: null });
  onReleased?.(now.person);
}
