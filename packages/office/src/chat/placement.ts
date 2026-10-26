import type { Placement, Scheduler } from "../scheduler/types.js";
import { orderQueue } from "../scheduler/policy.js";
import type { Store } from "../store/types.js";
import type { Candidate, ParsedPlacement } from "./types.js";

const words = (s: string) => s.toLowerCase().replaceAll(/[^a-z0-9#._ -]+/g, " ");

/**
 * Reads the requester's answer to "where does this go?". `candidates` are the person's other pieces of work in
 * the order they were listed (the active one first), so "after 2" means the second line of that list, with all its items. Returns nothing
 * when the answer is not one of: next, last, after an item, ask the PM.
 */
export function parsePlacement(text: string, candidates: Candidate[]): ParsedPlacement | undefined {
  const t = words(text);
  if (/\b(pm|product manager)\b|\bprioriti[sz]e\b/.test(t)) {
    return { type: "pm" };
  }

  const after = /\bafter\s+(.+)$/.exec(t);
  if (after) {
    const target = after[1]!.trim();
    if (/\b(current|active|running|this one|what you are doing)\b/.test(target)) {
      return { type: "next" };
    }

    const ordinal = /^#?(\d{1,3})\b/.exec(target);
    const byIndex = ordinal ? candidates[Number(ordinal[1]) - 1] : undefined;
    const hit =
      byIndex ??
      candidates.find((c) => c.ids.some((id) => target.includes(id.toLowerCase()))) ??
      candidates.find((c) => c.ticketKey && target.includes(c.ticketKey.toLowerCase())) ??
      candidates.find((c) => c.title.length > 3 && target.includes(c.title.toLowerCase()));

    return hit ? { type: "after", itemIds: hit.ids } : undefined;
  }

  if (/\b(next|first|right away|asap|now|urgent)\b/.test(t)) {
    return { type: "next" };
  }

  if (/\b(last|later|end of|whenever|no rush|at the end)\b/.test(t)) {
    return { type: "last" };
  }

  return undefined;
}

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
