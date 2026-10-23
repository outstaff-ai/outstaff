import type { Logger } from "@outstaff/core";
import { silentLogger } from "@outstaff/core";
import type { Offer } from "../office-client/index.js";

/** Where the office keeps the session of an item. */
export interface SessionStore {
  session(workItemId: string, sessionId: string): Promise<void>;
}

/**
 * One runtime session per work item (decision 0010): a later round resumes the session stored with the item, and a
 * session is never used for another item. The office persists the id, so it survives restarts of the agent.
 *
 * TODO(#43): chat threads get their own sessions, keyed by thread, with recent history as context. They need a
 * second key kind here and a place in the office to store it; until then only items have sessions.
 */
export interface SessionManager {
  /** The session to resume for the offered item, if an earlier round started one. */
  resumeFor(offer: Offer): string | undefined;

  /** Stores the session the runtime started (or kept) for the item, once. */
  started(workItemId: string, sessionId: string): Promise<void>;
}

export function createSessionManager(
  store: SessionStore,
  log: Logger = silentLogger,
): SessionManager {
  const known = new Map<string, string>();
  return {
    resumeFor(offer) {
      if (offer.sessionId) {
        known.set(offer.workItem.id, offer.sessionId);
      }

      return offer.sessionId;
    },

    async started(workItemId, sessionId) {
      if (known.get(workItemId) === sessionId) {
        return;
      }

      try {
        await store.session(workItemId, sessionId);
        known.set(workItemId, sessionId);
      } catch (e) {
        // The run goes on; the next round starts a new session from the journal if this one is lost.
        log.warn("could not store the session of a work item", {
          workItemId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}
