import type { ReadyTicket } from "./policy.types.js";

/** No priority sorts after every priority. */
const rank = (t: ReadyTicket): number => t.priority ?? Number.POSITIVE_INFINITY;

/**
 * The ticket an idle agent starts next: the most urgent by tracker priority (1 first), then the one that entered ready
 * first. Ties keep the order given.
 */
export function nextReadyTicket(tickets: readonly ReadyTicket[]): ReadyTicket | undefined {
  return tickets.toSorted(
    (a, b) => rank(a) - rank(b) || Date.parse(a.readyAt) - Date.parse(b.readyAt),
  )[0];
}
