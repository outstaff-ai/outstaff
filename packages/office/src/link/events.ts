import { prLabel } from "../log.js";
import type { Trace } from "../pipeline/trace.types.js";
import type { EventFilter, LinkStore } from "./link.types.js";

const PAGE = 200;

/** How many traces one request looks through at most; past that it answers with what it found and a cursor. */
export const SCAN_LIMIT = 2000;

function matches(t: Trace, f: EventFilter): boolean {
  const { event } = t;
  const involves = (person: string) =>
    event.actor.id === person ||
    t.decisions.some(
      (d) => (d.type === "wake" && d.person === person) || (d.type === "act" && d.as === person),
    );

  return (
    (f.source === undefined || event.id.split(":")[0] === f.source) &&
    (f.person === undefined || involves(f.person)) &&
    (f.ticket === undefined || event.subject.ticket === f.ticket) &&
    (f.pr === undefined || (event.subject.pr !== undefined && prLabel(event.subject.pr) === f.pr))
  );
}

/**
 * Traces newest first, filtered here, paged by event time. A page never ends in the middle of the events of one time,
 * so `before` = `nextBefore` picks up exactly where it stopped.
 */
export async function findEvents(
  store: LinkStore,
  f: EventFilter,
  scanLimit = SCAN_LIMIT,
): Promise<{ events: Trace[]; nextBefore?: string }> {
  const limit = f.limit ?? 50;
  const found: Trace[] = [];
  let before = f.before;
  let scanned = 0;
  let last: string | undefined;
  for (;;) {
    const page = (await store.listTraces({ limit: PAGE, ...(before ? { before } : {}) })).map(
      (r) => r.data as Trace,
    );

    for (const t of page) {
      const full = found.length >= limit || scanned >= scanLimit;
      if ((full && t.event.at !== last) || (f.since !== undefined && t.event.at <= f.since)) {
        return { events: found, ...(last ? { nextBefore: last } : {}) };
      }

      scanned++;
      last = t.event.at;
      if (matches(t, f)) {
        found.push(t);
      }
    }

    if (page.length < PAGE) {
      return { events: found };
    }

    before = last;
  }
}
