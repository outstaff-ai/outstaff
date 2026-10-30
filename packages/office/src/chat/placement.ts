import type { Placement, Scheduler } from "#/scheduler/types.js";
import { orderQueue } from "#/scheduler/policy.js";
import type { Store } from "#/store/types.js";

/** Moves a queued item. `next` means ahead of the other queued items; an active item is never interrupted. */
export async function placeQueued(
  deps: { store: Pick<Store, "getItem" | "listItems">; scheduler: Pick<Scheduler, "move"> },
  itemId: string,
  placement: Placement,
): Promise<void> {
  const item = await deps.store.getItem(itemId);
  if (!item || item.status !== "queued") {
    throw new Error(`work item ${itemId} is not queued`);
  }

  if (placement === "last") {
    return deps.scheduler.move(itemId, { last: true });
  }

  if (placement === "next") {
    const first = orderQueue(
      await deps.store.listItems({ person: item.person, status: "queued" }),
    ).find((i) => i.id !== itemId);

    return first ? deps.scheduler.move(itemId, { before: first.id }) : undefined;
  }

  return deps.scheduler.move(itemId, placement);
}
