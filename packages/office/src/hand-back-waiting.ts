import { itemTicket } from "./item-ticket.js";
import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord, TicketRecord, WorkState } from "./workstate/index.js";

const CLOSED = new Set(["done", "canceled"]);

/** A ticket that is not waiting on anyone: closed, or blocked (moved there on purpose, or already escalated). */
const NOT_WAITING = new Set([...CLOSED, "blocked"]);

type Reader = Pick<Store, "getSubject">;
type TicketReader = Pick<WorkState, "ticket" | "prsOfTicket" | "refreshTicket" | "subTickets">;

/** An open pull request of the ticket: in flight when it is open for a human's review, not a draft. */
const prPiece = (pr: PrRecord) => ({
  inFlight: !pr.draft,
  text: `pull request ${pr.title} is ${pr.draft ? "a draft" : "open for review"}`,
});

/** An open sub-ticket: in flight when it is in review, or an agent has it. */
function subPiece(key: string, record: TicketRecord | undefined) {
  const assignee = record?.assignee;
  if (record?.status === "review") {
    return { inFlight: true, text: `${key} is in review` };
  }

  return assignee?.kind === "agent"
    ? { inFlight: true, text: `${key} is with ${assignee.id}` }
    : { inFlight: false, text: `${key} is ${record?.status ?? "unknown"}` };
}

/**
 * What an item's ticket waits on, when everything open on it is work in flight: its open pull requests are open for
 * a human's review, and each open sub-ticket is in review or held by an agent. Nothing there is blocked, so a
 * `blocked` hand-back on it is taken as `silent`. Empty when the ticket has nothing open, when anything open is not in
 * flight (a draft, a sub-ticket a human holds outside review, one nobody holds), or when the ticket itself is blocked
 * or closed: a real block, which escalates. The ticket and its sub-tickets are read again first, as the agent may have
 * changed them in the round.
 */
export function officeWaitingOn(deps: { store: Reader; workState: TicketReader }) {
  const { store, workState } = deps;
  const reread = (key: string, by?: { kind: "agent"; id: string }) =>
    workState.refreshTicket(key, by).catch(() => undefined);

  return async (item: WorkItem): Promise<string[]> => {
    const ticket = await itemTicket(store, item);
    if (!ticket) {
      return [];
    }

    // The agent's hand-back is what the ticket is read for, so a ticket found closed names it as the closer.
    await reread(ticket, { kind: "agent", id: item.person });
    const subs = workState.subTickets(ticket);
    await Promise.all(subs.map((key) => reread(key)));
    if (NOT_WAITING.has(workState.ticket(ticket)?.status ?? "")) {
      return [];
    }

    const pieces = [
      ...workState
        .prsOfTicket(ticket)
        .filter((pr) => pr.state === "open")
        .map(prPiece),
      ...subs
        .map((key) => [key, workState.ticket(key)] as const)
        .filter(([, record]) => !CLOSED.has(record?.status ?? ""))
        .map(([key, record]) => subPiece(key, record)),
    ];

    return pieces.length > 0 && pieces.every((p) => p.inFlight) ? pieces.map((p) => p.text) : [];
  };
}
