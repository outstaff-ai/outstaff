import type { Run, WorkItem } from "#/store/types.js";
import type { SchedulerDeps } from "./checks.types.js";
import { isLoopGuarded } from "./policy.js";
import type { NotStarted, OfferResult } from "./types.js";

/** Why a queued item is not offered yet: the backoff after a failure, or the hold that lets close wakes fold in. */
const heldUntil = (item: WorkItem) =>
  item.failures > 0
    ? `Held back after a failed run until ${item.notBefore}.`
    : `Held until ${item.notBefore}, so wakes that come close together run as one.`;

/** Why the item cannot start now: it is not queued, its person has no room, or it backs off after a failure. */
async function notReady(deps: SchedulerDeps, item: WorkItem): Promise<NotStarted | undefined> {
  const { checks } = deps;
  if (item.status !== "queued") {
    return { started: false, reason: "not_queued", detail: `Item is ${item.status}.` };
  }

  if (!(await checks.hasRoom(item))) {
    return { started: false, reason: "busy", detail: await checks.busyDetail(item) };
  }

  return checks.backingOff(item)
    ? { started: false, reason: "backoff", detail: heldUntil(item) }
    : undefined;
}

/** Why the item is held back: a pause, too little usage left, or the loop guard, which blocks it. */
async function heldBack(deps: SchedulerDeps, item: WorkItem): Promise<NotStarted | undefined> {
  const { pauseBlock, usageBlock, guardTripped, blockItem } = deps.checks;
  const held = (await pauseBlock(item.person)) ?? (await usageBlock(item.person, item));
  if (held) {
    return { started: false, reason: held.code, detail: held.reason };
  }

  const tripped = await guardTripped(item);
  if (!tripped) {
    return undefined;
  }

  const blocked = await blockItem(item, tripped, "loop_guard");
  return { started: false, reason: "loop_guard", detail: tripped, blocked };
}

/**
 * Makes a queued item active for its agent once every policy allows it. The item holds the person's lane, and the
 * loop guard counts it, but no run starts until the agent accepts (`startRun`).
 */
export async function offerItem(deps: SchedulerDeps, itemId: string): Promise<OfferResult> {
  const { store, checks } = deps;
  const item = await store.getItem(itemId);
  if (!item) {
    throw new Error(`unknown work item: ${itemId}`);
  }

  const refused = (await notReady(deps, item)) ?? (await heldBack(deps, item));
  if (refused) {
    return refused;
  }

  const stopped = await checks.stop(item);
  if (stopped) {
    return { started: false, reason: "stopped", detail: stopped };
  }

  const active = await store.activateItem(itemId);
  if (!active) {
    return { started: false, reason: "not_queued", detail: "Item is no longer queued." };
  }

  if (isLoopGuarded(active.trigger)) {
    await store.recordLoopGuard(active.id);
  }

  return { started: true, item: active };
}

/** The run of an active item the agent accepted: the one already open (a repeated accept), else a new one. */
export async function startItemRun(deps: SchedulerDeps, itemId: string): Promise<Run | null> {
  const { store, checks } = deps;
  const item = await store.getItem(itemId);
  if (item?.status !== "active") {
    return null;
  }

  return (await checks.openRun(itemId)) ?? (await store.startRun(itemId));
}
