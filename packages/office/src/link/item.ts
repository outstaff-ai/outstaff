import type { LinkItem } from "@outstaff/protocol";
import { ITEM_EVENTS_SUBJECT } from "../pipeline/live/wake.js";
import type { Trace } from "../pipeline/trace.types.js";
import { scheduledBy as reasonOf } from "./items.js";
import type { LinkStore } from "./link.types.js";

const LATEST = 5;
const CLIP = 500;

/** One work item with its runs, the end of its journal and the events that queued or joined it; undefined if none. */
export async function findItem(
  store: LinkStore,
  id: string,
): Promise<{ item: LinkItem; traces: Trace[] } | undefined> {
  const item = await store.getItem(id);
  if (!item) {
    return undefined;
  }

  const [runs, journal, scheduledBy, events] = await Promise.all([
    store.listRuns(id),
    store.readJournal(id),
    reasonOf(store, id),
    store.getSubject(ITEM_EVENTS_SUBJECT, id),
  ]);

  const traces = await Promise.all(
    ((events?.data as string[] | undefined) ?? []).map((e) => store.getTrace(e)),
  );

  return {
    item: {
      id: item.id,
      kind: item.kind,
      title: item.title,
      subject: item.subject,
      person: item.person,
      status: item.status,
      priority: item.priority,
      trigger: item.trigger,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      scheduledBy,
      runs: runs.map((r) => ({
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        outcome: r.outcome,
        error: r.error,
      })),
      journal: {
        entries: journal.length,
        latest: journal.slice(-LATEST).map((j) => ({
          at: j.at,
          author: j.author,
          text: j.text.length > CLIP ? `${j.text.slice(0, CLIP)}…` : j.text,
        })),
      },
    },
    traces: traces
      .flatMap((t) => (t ? [t.data as Trace] : []))
      .toSorted((a, b) => a.event.at.localeCompare(b.event.at)),
  };
}
