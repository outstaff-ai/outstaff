import { openSubTickets } from "@outstaff/core";
import { definePolicy, type PipelineEvent, type PolicyContext } from "@outstaff/policy";
import { HANDED_IN, withHandedIn } from "./hand-in.js";
import { handedOver, requesterOf, UNLESS_HANDED_OVER } from "./handover.js";
import { acts } from "./spec.js";

const toReview = acts({ as: "actor", ops: [{ move: "review" }, { assign: "requester" }] });

const staysActive = acts({ as: "actor", ops: [{ move: "active" }, { assign: "self" }] });

/**
 * The item's own ticket: to review with the requester; a parent with open sub-tickets stays active with the agent
 * instead, until its last sub-ticket closes.
 */
function ownTicket(event: PipelineEvent, ctx: PolicyContext) {
  const open = ctx.ticket ? openSubTickets(ctx.state, ctx.ticket) : [];
  if (open.length === 0) {
    return toReview.decide(event, ctx);
  }

  const kept = staysActive.decide(event, ctx);
  const why = `${ctx.ticket} has open sub-tickets (${open.join(", ")}): it stays active with ${ctx.event.actor.id} until the last one closes`;
  return kept.map((p) =>
    p.type === "act" ? { ...p, reason: why } : { type: "drop" as const, reason: why },
  );
}

export const policy = definePolicy({
  id: "hand_back_done",
  summary:
    "A hand-back as done moves the ticket to review and gives it to the requester, for the agent, unless the agent handed the ticket over to someone else during the work; a ticket with open sub-tickets stays active with the agent instead. The work item's other tickets awaiting review (the ones it created that are in review, and the ones whose pull request it opened) go to review and to the requester too. A merge round's hand-back leaves the ticket as it is: nothing in it is left for the human.",
  on: ["agent.handed_back"],
  when: {
    all: [
      { hand_back_status: ["done"] },
      { not: { work_kind: ["merge"] } },
      { not: { ticket_status: ["blocked", "done", "canceled"] } },
    ],
  },
  decides: `${toReview.decides}, ${UNLESS_HANDED_OVER}; a ticket with open sub-tickets stays \`active\` with the agent instead; ${HANDED_IN}`,
  decide: (event, ctx) => {
    const to = requesterOf(ctx);
    const kept = handedOver(ctx, to);
    return withHandedIn(ctx, kept.length > 0 ? kept : ownTicket(event, ctx), to);
  },
});
