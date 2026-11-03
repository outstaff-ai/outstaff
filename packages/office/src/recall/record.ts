import type { WorkflowEvent } from "@outstaff/core";
import type { StoredEvent } from "#/store/types.js";
import { eventMoment } from "./event-moment.js";
import type { RecallIndex, RecallIndexOptions } from "./types.js";

/** Where the catch-up over events recorded before the index existed has got to: the last `received_at` it indexed. */
const CURSOR = { source: "recall", key: "events" } as const;
const PAGE = 500;

/** The event a stored payload carries, as intake and the work state record it. */
const eventOf = (e: StoredEvent) => (e.payload as { event?: WorkflowEvent } | null)?.event;

/**
 * Indexes the events the office judges as moments agents can recall. Failing to index never stops an event: it is
 * logged, and the same event indexes on its next delivery or the next catch-up.
 */
export function createRecallIndex(opts: RecallIndexOptions): RecallIndex {
  const { store, prKey, clock, log } = opts;
  const index = async (event: WorkflowEvent, id: string, at: string) => {
    const moment = eventMoment(event, id, at, prKey);
    if (moment) {
      await store.recordMoment(moment);
    }
  };

  const catchUp = async () => {
    let after = await store.getCursor(CURSOR.source, CURSOR.key);
    for (;;) {
      const page = await store.listEventsAfter({ after, limit: PAGE });
      if (page.length === 0) {
        return;
      }

      for (const e of page) {
        const event = eventOf(e);
        if (event) {
          await index(event, `${e.source}:${e.externalId}`, e.receivedAt);
        }
      }

      after = page.at(-1)!.receivedAt;
      await store.setCursor(CURSOR.source, CURSOR.key, after);
    }
  };

  return {
    async record(event, meta) {
      try {
        await index(event, `${meta.source}:${meta.externalId}`, clock.now().toISOString());
      } catch (error) {
        log.warn("could not index an event for recall", {
          event: `${meta.source}:${meta.externalId}`,
          error: String(error),
        });
      }
    },

    async catchUp() {
      try {
        await catchUp();
      } catch (error) {
        log.warn("could not index earlier events for recall", { error: String(error) });
      }
    },
  };
}
