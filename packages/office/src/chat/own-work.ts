import type { PrRecord, TicketRecord } from "#/workstate/index.js";

/** Whether the ticket is assigned to the agent. */
export const assignedTo = (person: string, t: TicketRecord | undefined): boolean =>
  t?.assignee?.kind === "agent" && t.assignee.id === person;

/**
 * Whether a ticket is the agent's work: assigned to it, or it was the last to work on it (a hand-back assigns the
 * ticket to the requester). `lastWorker` is who last worked on it, as the work state knows.
 */
export const ownsTicket = (
  person: string,
  t: TicketRecord | undefined,
  lastWorker: string | undefined,
): boolean => assignedTo(person, t) || (t !== undefined && lastWorker === person);

/** Whether a pull request is the agent's work: it opened it, or the ticket it implements is the agent's. */
export const ownsPr = (person: string, pr: PrRecord, ticketOwned: boolean): boolean =>
  pr.author.person === person || ticketOwned;
