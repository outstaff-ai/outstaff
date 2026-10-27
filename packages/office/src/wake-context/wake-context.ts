import type { WakeContext } from "@outstaff/protocol";
import { ITEM_EVENTS_SUBJECT } from "#/pipeline/live/wake.js";
import { buildWakeContext, recordContext } from "#/pipeline/context/index.js";
import type { Store, WorkItem } from "#/store/types.js";
import { gatherGraph } from "./gather.js";
import type { ContextReaders, WakeContextOptions } from "./types.js";

/** The events that may have woken the item, latest first: those the pipeline queued it for, then its references'. */
async function eventsOf(store: Store, itemId: string): Promise<string[]> {
  const queued =
    ((await store.getSubject(ITEM_EVENTS_SUBJECT, itemId))?.data as string[] | undefined) ?? [];

  const sources = (await store.listItemRefs(itemId)).map((r) => r.source).toReversed();
  return [...new Set([...queued.toReversed(), ...sources])];
}

const isEmpty = (c: WakeContext) =>
  c.tickets.length + c.prs.length + c.docs.length + c.chats.length === 0;

/**
 * The context bundle each wake of an item carries: what the office knows around it, built by the context builder and,
 * for a new offer, recorded in the trace of the event that woke it. Best effort: an item is offered without a bundle
 * rather than not at all.
 */
export function wakeContextOf(readers: ContextReaders, opts: WakeContextOptions) {
  const { limits, traces } = opts;
  return async (item: WorkItem, fresh: boolean): Promise<WakeContext | undefined> => {
    try {
      const graph = await gatherGraph(readers, item.id, limits.items * 2);
      const { context, manifest } = buildWakeContext(graph, limits);
      if (fresh && traces) {
        await recordContext(traces, await eventsOf(readers.store, item.id), manifest);
      }

      return isEmpty(context) ? undefined : context;
    } catch (error) {
      opts.logger?.warn("could not build the context of a wake", {
        item: item.id,
        error: String(error),
      });

      return undefined;
    }
  };
}
