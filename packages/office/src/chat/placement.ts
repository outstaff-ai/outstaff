import type { Placement, Scheduler } from "../scheduler/types.js";
import { orderQueue } from "../scheduler/policy.js";
import type { Store } from "../store/types.js";
import type { Candidate, ParsedPlacement } from "./types.js";

const words = (s: string) => s.toLowerCase().replaceAll(/[^a-z0-9#._ -]+/g, " ");

const PM = /\b(pm|product manager)\b|\bprioriti[sz]e\b/;
const NEXT = /\b(next|first|right away|asap|now|urgent)\b/;
const LAST = /\b(last|later|end of|whenever|no rush|at the end)\b/;
const CURRENT = /\b(current|active|running|this one|what you are doing)\b/;

/** The listed piece of work the answer names: by its number in the list, an item id, its ticket, or its title. */
function candidateIn(target: string, candidates: Candidate[]): Candidate | undefined {
  const ordinal = /^#?(\d{1,3})\b/.exec(target);
  const byIndex = ordinal ? candidates[Number(ordinal[1]) - 1] : undefined;
  return (
    byIndex ??
    candidates.find((c) => c.ids.some((id) => target.includes(id.toLowerCase()))) ??
    candidates.find((c) => c.ticketKey && target.includes(c.ticketKey.toLowerCase())) ??
    candidates.find((c) => c.title.length > 3 && target.includes(c.title.toLowerCase()))
  );
}

/** "after <target>": after the work it names; after the running work is simply next. */
function placeAfter(target: string, candidates: Candidate[]): ParsedPlacement | undefined {
  if (CURRENT.test(target)) {
    return { type: "next" };
  }

  const hit = candidateIn(target, candidates);
  return hit ? { type: "after", itemIds: hit.ids } : undefined;
}

/**
 * Reads the requester's answer to "where does this go?". `candidates` are the person's other pieces of work in
 * the order they were listed (the active one first), so "after 2" means the second line of that list, with all its items. Returns nothing
 * when the answer is not one of: next, last, after an item, ask the PM.
 */
export function parsePlacement(text: string, candidates: Candidate[]): ParsedPlacement | undefined {
  const t = words(text);
  if (PM.test(t)) {
    return { type: "pm" };
  }

  const after = /\bafter\s+(.+)$/.exec(t);
  if (after) {
    return placeAfter(after[1]!.trim(), candidates);
  }

  if (NEXT.test(t)) {
    return { type: "next" };
  }

  return LAST.test(t) ? { type: "last" } : undefined;
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
