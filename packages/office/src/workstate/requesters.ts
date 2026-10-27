import type { PrRef, WorkflowEvent } from "@outstaff/core";
import type { RequesterOps, TicketOps, WorkstateCore } from "./core.types.js";
import { isTerminal } from "./derive.js";
import { trustedHuman } from "./tickets.js";
import type { PrRecord, TicketRecord } from "./types.js";

/** The ticket states an agent hands a ticket back in. */
const HANDED_BACK = new Set<string | undefined>(["review", "blocked"]);

const hasText = (v: unknown) => typeof v === "string" && v.trim() !== "";

const hasItems = (v: unknown) => Array.isArray(v) && v.length > 0;

/** A bare approval, with no text and no comments: nothing in it for the agent to act on. */
const signsOff = (event: WorkflowEvent) =>
  event.data["state"] === "approved" &&
  !hasText(event.data["body"]) &&
  !hasItems(event.data["comments"]);

/** The ticket of an open pull request an agent wrote; feedback on other pull requests goes to no ticket. */
const agentPrTicket = (rec: PrRecord | undefined) =>
  rec?.state === "open" && rec.author.kind === "agent" ? rec.ticket : undefined;

/** A comment that mentions an agent hands the ticket to it, so the next hand-back goes to who wrote the comment. */
const handsOver = (event: WorkflowEvent, ticket: TicketRecord) =>
  hasItems(event.data["mentions"]) && ticket.status !== undefined && !isTerminal(ticket.status);

/** A ticket handed back to its human assignee. */
const waitsOnHuman = (ticket: TicketRecord) =>
  ticket.assignee?.kind === "human" && HANDED_BACK.has(ticket.status);

/** Who a ticket goes back to: the trusted human whose feedback reactivated it. */
export function createRequesters(core: WorkstateCore, ticketOps: TicketOps): RequesterOps {
  const { team, tickets, prs, prSubject } = core;
  const { ensureTicket, saveTicket, withRequester } = ticketOps;

  /** What the tracker knows the human as: pull request actors are code host logins, so map them through `humans:`. */
  const trackerIdentity = (login: string): string => {
    const lower = login.toLowerCase();
    const human = team.humans?.find((h) => h.identities.vcs?.toLowerCase() === lower);
    return human?.identities.tracker ?? login;
  };

  /** A trusted human's feedback that sends a ticket back to its agent (as `human-feedback-reactivates-ticket` does). */
  const recordFeedbackRequester = async (event: WorkflowEvent, ref: PrRef) => {
    const login = trustedHuman(event);
    const key = agentPrTicket(prs.get(prSubject(ref)));
    if (!login || !key || signsOff(event)) {
      return;
    }

    if (!(await ensureTicket(key))) {
      return;
    }

    const ticket = tickets.get(key)!;
    if (HANDED_BACK.has(ticket.status)) {
      await saveTicket(withRequester(ticket, trackerIdentity(login), event));
    }
  };

  /**
   * A trusted human's comment on a ticket an agent handed back sends it back to the agent (as
   * `ticket-comment-reactivates-ticket` does), so that person is who the next hand-back goes to.
   */
  const recordCommentRequester = async (key: string, event: WorkflowEvent) => {
    const person = trustedHuman(event);
    const ticket = tickets.get(key);
    if (!person || !ticket) {
      return;
    }

    if (handsOver(event, ticket) || waitsOnHuman(ticket)) {
      await saveTicket(withRequester(ticket, person, event));
    }
  };

  return { recordFeedbackRequester, recordCommentRequester };
}
