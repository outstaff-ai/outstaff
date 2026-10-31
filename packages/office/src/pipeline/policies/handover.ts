import type { PolicyContext, Proposal } from "@outstaff/policy";

/** The human a hand-back gives the ticket to: its requester, else the team's fallback. */
export function requesterOf(ctx: PolicyContext): string | undefined {
  const requester = ctx.ticket ? ctx.state.requester(ctx.ticket) : undefined;
  return requester ?? ctx.options.fallbackRequester;
}

/**
 * The drop of a hand-back that leaves its ticket alone: during the work the agent gave the ticket to someone other
 * than `to`, where the hand-back would put it, and a hand-back never undoes a hand-over. None while the ticket is
 * still the agent's (assigned to it, or to nobody) or already with `to`.
 */
export function handedOver(ctx: PolicyContext, to: string | undefined): Proposal[] {
  const { ticket } = ctx;
  const assignee = ticket ? ctx.state.assignee(ticket) : undefined;
  const actor = ctx.event.actor.id;
  if (!assignee || assignee.id === actor || assignee.id === to) {
    return [];
  }

  return [
    {
      type: "drop",
      reason: `${actor} handed ${ticket} over to ${assignee.kind} ${assignee.id} during the work, and a hand-back does not undo a hand-over`,
    },
  ];
}

/** What every hand-back policy decides besides its act, in words for the reference. */
export const UNLESS_HANDED_OVER = "unless the agent handed the ticket over to someone else";
