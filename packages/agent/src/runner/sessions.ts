import { silentLogger, type Logger } from "@outstaff/core";
import type { Offer } from "#/office-client/index.js";
import type { SessionStore, SessionManager } from "./types.js";

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

    async started(workItemId, sessionId, model) {
      const key = keyOfItem.get(workItemId) ?? `item:${workItemId}`;
      if (known.get(key) === sessionId && !model) {
        return;
      }

      try {
        await store.session(workItemId, sessionId, model);
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
