import type { NoticeSeen } from "@outstaff/policy";
import type { Store } from "#/store/types.js";

/**
 * What the last notice about a ticket put in front of its human, keyed by the ticket: office bookkeeping, which the next
 * hand-back on the ticket carries as `data.notified` so a round that changed nothing for the human tells them nothing.
 */
export const NOTIFIED_SUBJECT = "handoff_notified";

export const readNotified = async (
  store: Pick<Store, "getSubject">,
  ticket: string,
): Promise<NoticeSeen | undefined> =>
  (await store.getSubject(NOTIFIED_SUBJECT, ticket))?.data as NoticeSeen | undefined;

export const writeNotified = (
  store: Pick<Store, "upsertSubject">,
  ticket: string,
  seen: NoticeSeen,
): Promise<void> => store.upsertSubject(NOTIFIED_SUBJECT, ticket, seen);
