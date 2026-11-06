import type { WorkSummary } from "@outstaff/protocol";
import { summarizeItem } from "#/item-summary.js";
import { CHAT_KIND, orderQueue } from "#/scheduler/index.js";
import type { WorkItem } from "#/store/types.js";
import type { ContextReaders } from "./types.js";

/** The agent's open work, in the order a chat session lists it: running, then the queue, then what waits. */
const OPEN: WorkItem["status"][] = ["active", "queued", "waiting", "blocked"];

const byStatus = (a: WorkItem, b: WorkItem) => OPEN.indexOf(a.status) - OPEN.indexOf(b.status);

/**
 * For a chat session: the person's own open work items, the running ones first, then the queue in the order it runs,
 * then the ones waiting or blocked, so the session attaches a request a round already covers instead of filing it
 * again. Other chat sessions are left out. Undefined for any other item.
 */
export async function workListOf(
  r: ContextReaders,
  item: WorkItem,
  max: number,
): Promise<WorkSummary[] | undefined> {
  if (item.kind !== CHAT_KIND) {
    return undefined;
  }

  const open = (await r.store.listItems({ person: item.person })).filter(
    (i) => OPEN.includes(i.status) && i.kind !== CHAT_KIND,
  );

  const ordered = orderQueue(open).toSorted(byStatus).slice(0, max);
  return Promise.all(ordered.map((i) => summarizeItem(r.store, i)));
}
