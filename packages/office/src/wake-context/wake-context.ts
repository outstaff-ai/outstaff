import type { ContextMerge, WakeContext } from "@outstaff/protocol";
import { ITEM_EVENTS_SUBJECT } from "#/pipeline/live/wake.js";
import {
  buildWakeContext,
  recordContext,
  type ContextManifest,
  type MergeManifest,
} from "#/pipeline/context/index.js";
import { MERGE_KIND } from "#/scheduler/index.js";
import type { Store, WorkItem } from "#/store/types.js";
import { gatherGraph } from "./gather.js";
import { mergeContextOf } from "./merge.js";
import type { ContextReaders, WakeContextOptions } from "./types.js";

/** The events that may have woken the item, latest first: those the pipeline queued it for, then its references'. */
async function eventsOf(store: Store, itemId: string): Promise<string[]> {
  const queued =
    ((await store.getSubject(ITEM_EVENTS_SUBJECT, itemId))?.data as string[] | undefined) ?? [];

  const sources = (await store.listItemRefs(itemId)).map((r) => r.source).toReversed();
  return [...new Set([...queued.toReversed(), ...sources])];
}

const isEmpty = (c: WakeContext) =>
  c.tickets.length + c.prs.length + c.docs.length + c.chats.length === 0 && !c.merge;

/** A merge item's context of the merge, when the office knows its pull request. */
async function mergeOf(readers: ContextReaders, item: WorkItem, limit: number) {
  return item.kind === MERGE_KIND && item.subject?.type === "pr"
    ? mergeContextOf(readers, item.subject.ref, limit)
    : undefined;
}

/** What a merge's context named, for the trace. */
const mergeManifest = (m: ContextMerge): MergeManifest => ({
  pr: m.pr.ref,
  base: { ref: m.base.ref, ci: m.base.ci },
  others: m.others.map((o) => ({ ref: o.ref, relation: o.relation })),
  moreOthers: m.moreOthers ?? 0,
  recentMerges: m.recentMerges.map((r) => r.ref),
});

function withMerge(
  built: { context: WakeContext; manifest: ContextManifest },
  merge: ContextMerge | undefined,
) {
  return merge
    ? {
        context: { ...built.context, merge },
        manifest: { ...built.manifest, merge: mergeManifest(merge) },
      }
    : built;
}

/**
 * The context bundle each wake of an item carries: what the office knows around it, built by the context builder (and
 * for a merge, what the merge is decided with) and, for a new offer, recorded in the trace of the event that woke it.
 * Best effort: an item is offered without a bundle rather than not at all.
 */
export function wakeContextOf(readers: ContextReaders, opts: WakeContextOptions) {
  const { limits, traces } = opts;
  return async (item: WorkItem, fresh: boolean): Promise<WakeContext | undefined> => {
    try {
      const graph = await gatherGraph(readers, item.id, limits.items * 2);
      const merge = await mergeOf(readers, item, limits.items);
      const { context, manifest } = withMerge(buildWakeContext(graph, limits), merge);
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
