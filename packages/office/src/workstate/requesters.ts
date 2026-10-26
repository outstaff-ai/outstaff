import type { PrRef, WorkflowEvent } from "@outstaff/core";
import type { RequesterOps, TicketOps, WorkstateCore } from "./core.types.js";
import { TERMINAL } from "./derive.js";
import { trustedHuman } from "./tickets.js";

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
    const rec = prs.get(prSubject(ref));
    const body = event.data["body"];
    const comments = event.data["comments"];
    const signOff =
      event.data["state"] === "approved" &&
      !(typeof body === "string" && body.trim() !== "") &&
      !(Array.isArray(comments) && comments.length > 0);

    if (!login || !rec?.ticket || rec.state !== "open" || rec.author.kind !== "agent" || signOff) {
      return;
    }

    if (!(await ensureTicket(rec.ticket))) {
      return;
    }

    const ticket = tickets.get(rec.ticket)!;
    if (ticket.status === "review" || ticket.status === "blocked") {
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
    // A comment that mentions an agent hands the ticket to it, so the next hand-back goes to who wrote the comment.
    const mentions = event.data["mentions"];
    const handsOver =
      Array.isArray(mentions) &&
      mentions.length > 0 &&
      ticket?.status !== undefined &&
      !TERMINAL.has(ticket.status);

    if (
      !person ||
      !ticket ||
      (!handsOver &&
        (ticket.assignee?.kind !== "human" ||
          (ticket.status !== "review" && ticket.status !== "blocked")))
    ) {
      return;
    }

    await saveTicket(withRequester(ticket, person, event));
  };

  return { recordFeedbackRequester, recordCommentRequester };
}
