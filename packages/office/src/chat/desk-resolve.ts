import { ProtocolError } from "#/protocol/errors.js";
import type { PrRecord, TicketRecord, WorkState } from "#/workstate/index.js";
import type { OwnWork } from "./types.js";

type State = Pick<WorkState, "pullRequests" | "ticket" | "prSubject" | "lastWorker">;

const assignedTo = (person: string, t?: TicketRecord) =>
  t?.assignee?.kind === "agent" && t.assignee.id === person;

/** Work the agent can attach to: assigned to it, or it was the last to work on it (a hand-back reassigns to the requester). */
const ownTicket = (state: State, person: string, t?: TicketRecord) =>
  assignedTo(person, t) || (t !== undefined && state.lastWorker(t.key) === person);

/** The existing work a verb argument names (a ticket key or a pull request), if it is the person's own. */
export function resolveOwnWork(state: State, person: string, text: string): OwnWork {
  const t = text.trim();
  const refuse = (why: string): never => {
    throw new ProtocolError("invalid", why);
  };

  const mine = (pr: PrRecord) =>
    pr.author.person === person ||
    ownTicket(state, person, pr.ticket ? state.ticket(pr.ticket) : undefined);

  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(t)) {
    const ticket = state.ticket(t) ?? state.ticket(t.toUpperCase());
    if (!ticket || !ownTicket(state, person, ticket)) {
      return refuse(
        `No ticket ${t} is your work: it is not assigned to you and you were not the last to work on it. Attach a request only to your own work.`,
      );
    }

    return { ticket };
  }

  const number = /(?:^|[#/])(\d+)$/.exec(t)?.[1];
  if (number === undefined) {
    return refuse(
      `Say a ticket key (ACME-11) or a pull request (11, #11, owner/repo#11 or its link), not "${t}".`,
    );
  }

  const found = state.pullRequests(Number(number)).filter(mine);
  const named = found.filter(
    (p) => t.includes("/") && t.toLowerCase().includes(p.ref.repo.name.toLowerCase()),
  );

  const pool = named.length > 0 ? named : found;
  if (pool.length === 0) {
    return refuse(`No pull request #${number} is yours. Attach a request only to your own work.`);
  }

  if (pool.length > 1) {
    return refuse(
      `More than one of your repositories has a pull request #${number}; say which: ${pool.map((p) => state.prSubject(p.ref)).join(", ")}.`,
    );
  }

  const pr = pool[0]!;
  return {
    pr,
    ...(pr.ticket && state.ticket(pr.ticket) ? { ticket: state.ticket(pr.ticket)! } : {}),
  };
}
