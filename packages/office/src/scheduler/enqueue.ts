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

/**
 * The held item a wake folds into, and when its window closes: one whose window is still open at the wake's time and
 * that has not started.
 */
async function openWindow(
  store: Store,
  c: Coalesce,
): Promise<{ item: WorkItem; until: string } | undefined> {
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
  return item?.status === "queued" ? { item, until: open.until } : undefined;
}

/**
 * Opens the item's window and holds it until the window closes (`until`, else the wake's time and window), unless that
 * time has passed already.
 */
async function hold(
  deps: SchedulerDeps,
  item: WorkItem,
  c: Coalesce,
  until = new Date(Date.parse(c.at) + c.windowMs).toISOString(),
): Promise<WorkItem> {
  if (c.windowMs <= 0) {
    return item;
  }

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

/** Creates the item, held for its coalescing window if it has one (until `until`, for one that took a held item over). */
async function create(
  deps: SchedulerDeps,
  input: Omit<EnqueueInput, "placement" | "init">,
  until?: string,
): Promise<WorkItem> {
  const { coalesce, ...rest } = input;
  const created = await deps.store.enqueue({
    ...rest,
    priority: input.priority ?? priorityFor(input.trigger, input.kind),
  });

  return coalesce ? hold(deps, created, coalesce, until) : created;
}

/** What a wake meets in its window: a held item to fold into, or one it takes over, with what moves it across. */
type Met =
  | { fold: WorkItem }
  | { over: WorkItem; until: string; absorb: (into: WorkItem) => Promise<void> };

async function meet(store: Store, c: Coalesce | undefined): Promise<Met | undefined> {
  const open = c ? await openWindow(store, c) : undefined;
  if (!open) {
    return undefined;
  }

  const absorb = c!.takesOver?.(open.item);
  return absorb ? { over: open.item, until: open.until, absorb } : { fold: open.item };
}

/** The held item a wake took over: it carries on in the new item, and is canceled, saying so. */
async function takenOver(store: Store, met: Extract<Met, { over: WorkItem }>, by: WorkItem) {
  await met.absorb(by);
  await store.updateItem(met.over.id, { status: "canceled" });
  await store.appendJournal(
    met.over.id,
    "office",
    `Taken over by work item ${by.id} (${by.kind}): it gives the ticket to work on, and this item's feedback went with it.`,
  );
}

/**
 * Queues an item, or folds it into the held item of the same coalescing key. A wake that wins over the held item
 * (`takesOver`) queues its own instead, held until the same time, and the held one is canceled into it. `held` hears
 * of an item held for its window, so it can be released on time.
 */
export async function enqueueItem(
  deps: SchedulerDeps,
  input: EnqueueInput,
  held: (item: WorkItem) => void,
): Promise<WorkItem> {
  const { store } = deps;
  const { placement, init, ...rest } = input;
  const met = await meet(store, rest.coalesce);
  if (met && "fold" in met) {
    await rest.coalesce!.fold(met.fold);
    return met.fold;
  }

  const created = await create(deps, rest, met?.until);
  if (created.notBefore !== null) {
    held(created);
  }

  await init?.(created);
  if (met) {
    await takenOver(store, met, created);
  }

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
