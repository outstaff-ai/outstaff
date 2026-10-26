import type { ReadyTicket } from "./state.types.js";

/** The ticket an idle agent starts next: the one that entered ready first. Ties keep the order given. */
export function nextReadyTicket(tickets: readonly ReadyTicket[]): ReadyTicket | undefined {
  return tickets.toSorted((a, b) => a.readyAt.localeCompare(b.readyAt))[0];
}
