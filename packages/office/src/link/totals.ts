import { matches, PAGE, readPage } from "./events.js";
import type { EventFilter, LinkStore } from "./link.types.js";

/** Whether any filter has to look inside the traces; without one the store can count by event time alone. */
const looksInside = (f: EventFilter) =>
  [f.source, f.person, f.ticket, f.pr, f.differs].some((v) => v !== undefined);

/** How many events match the filters, however a request pages them: `before` and `limit` do not count. */
export async function countEvents(store: LinkStore, f: EventFilter): Promise<number> {
  if (!looksInside(f)) {
    return store.countTraces({ since: f.since });
  }

  let total = 0;
  let before: string | undefined;
  for (;;) {
    const page = await readPage(store, before);
    const inRange = page.filter((t) => f.since === undefined || t.event.at > f.since);
    total += inRange.filter((t) => matches(t, f)).length;
    if (page.length < PAGE || inRange.length < page.length) {
      return total;
    }

    before = page.at(-1)!.event.at;
  }
}
