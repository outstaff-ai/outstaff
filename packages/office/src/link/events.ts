import { prLabel } from "#/log.js";
import type { Trace } from "#/pipeline/trace.types.js";
import type { EventFilter, LinkStore } from "./link.types.js";

const PAGE = 200;

/** How many traces one request looks through at most; past that it answers with what it found and a cursor. */
export const SCAN_LIMIT = 2000;

const involves = (t: Trace, person: string) =>
  t.event.actor.id === person ||
  t.decisions.some(
    (d) => (d.type === "wake" ? d.person : d.type === "act" ? d.as : undefined) === person,
  );

const prOf = (t: Trace) => (t.event.subject.pr ? prLabel(t.event.subject.pr) : undefined);

/** One test per filter; a filter that is not given lets everything through. */
const FILTERS: ((t: Trace, f: EventFilter) => boolean)[] = [
  (t, f) => f.source === undefined || t.event.id.split(":")[0] === f.source,
  (t, f) => f.person === undefined || involves(t, f.person),
  (t, f) => f.ticket === undefined || t.event.subject.ticket === f.ticket,
  (t, f) => f.pr === undefined || prOf(t) === f.pr,
  (t, f) => f.differs === undefined || t.comparison?.agree === false,
];

const matches = (t: Trace, f: EventFilter) => FILTERS.every((test) => test(t, f));

/** Where a search stands: what it found, how many traces it looked at, and the time of the last one. */
interface Scan {
  found: Trace[];
  scanned: number;
  last?: string | undefined;
}

/** Whether the search ends before this trace: the page is full (and the trace is of a new time), or it is too old. */
function ends(t: Trace, f: EventFilter, scan: Scan, scanLimit: number): boolean {
  const full = scan.found.length >= (f.limit ?? 50) || scan.scanned >= scanLimit;
  return (full && t.event.at !== scan.last) || (f.since !== undefined && t.event.at <= f.since);
}

const answer = (scan: Scan, more: boolean): { events: Trace[]; nextBefore?: string } => ({
  events: scan.found,
  ...(more && scan.last ? { nextBefore: scan.last } : {}),
});

const readPage = async (store: LinkStore, before: string | undefined) =>
  (await store.listTraces({ limit: PAGE, ...(before ? { before } : {}) })).map(
    (r) => r.data as Trace,
  );

/**
 * Traces newest first, filtered here, paged by event time. A page never ends in the middle of the events of one time,
 * so `before` = `nextBefore` picks up exactly where it stopped.
 */
export async function findEvents(
  store: LinkStore,
  f: EventFilter,
  scanLimit = SCAN_LIMIT,
): Promise<{ events: Trace[]; nextBefore?: string }> {
  const scan: Scan = { found: [], scanned: 0 };
  let before = f.before;
  for (;;) {
    const page = await readPage(store, before);
    for (const t of page) {
      if (ends(t, f, scan, scanLimit)) {
        return answer(scan, true);
      }

      scan.scanned++;
      scan.last = t.event.at;
      if (matches(t, f)) {
        scan.found.push(t);
      }
    }

    if (page.length < PAGE) {
      return answer(scan, false);
    }

    before = scan.last;
  }
}
