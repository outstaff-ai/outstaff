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
 * Chat sessions have a second kind of key, the thread. The chat sessions of one thread (the first, and a follow-up
 * after it was done) share one session, and a thread session is never used for an item that did not come
 * from that thread, nor an item session for a thread. The office stores both with the item and carries the id over
 * to the next item of the thread.
 */
export interface SessionManager {
  /** The session to resume for the offered item, if an earlier round started one. */
  resumeFor(offer: Offer): string | undefined;

  /** Stores the session the runtime started (or kept) for the item, once. */
  started(workItemId: string, sessionId: string): Promise<void>;
}

/**
 * The key a session is kept under: the chat thread of a chat session, else the work item. Work that a chat session
 * filed has the thread's origin too, but it runs under other permissions at the same time, so it has its own session.
 */
export function sessionKey(offer: Offer): string {
  const origin = offer.workItem.origin;
  return origin && offer.workItem.kind === "chat"
    ? `thread:${origin.channel}:${origin.thread}`
    : `item:${offer.workItem.id}`;
}

export function createSessionManager(
  store: SessionStore,
  log: Logger = silentLogger,
): SessionManager {
  const known = new Map<string, string>();
  const keyOfItem = new Map<string, string>();
  return {
    resumeFor(offer) {
      const key = sessionKey(offer);
      keyOfItem.set(offer.workItem.id, key);
      if (offer.sessionId) {
        known.set(key, offer.sessionId);
        return offer.sessionId;
      }

      // The follow-up of a chat thread continues the thread's session even if the office did not carry it over.
      return key.startsWith("thread:") ? known.get(key) : undefined;
    },

    async started(workItemId, sessionId) {
      const key = keyOfItem.get(workItemId) ?? `item:${workItemId}`;
      if (known.get(key) === sessionId) {
        return;
      }

      try {
        await store.session(workItemId, sessionId);
        known.set(key, sessionId);
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
