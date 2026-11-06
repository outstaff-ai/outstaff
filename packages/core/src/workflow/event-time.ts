import type { CanonicalStatus } from "#/ports/types.js";
import type { Ctx } from "./evaluate.types.js";

/**
 * Whether the event's agent had a round on the ticket under way when the event happened, and why when it is not read
 * from the rounds. An agent's event without a time is taken as in a round: a missed wake can be recovered, a loop of
 * agents waking each other cannot.
 */
export function roundOf(ctx: Ctx): [boolean, string] {
  const { actor, data } = ctx.event;
  const at = data["at"];
  if (actor.kind !== "agent" || ctx.ticket === undefined) {
    return [false, ""];
  }

  return typeof at === "string" && at !== ""
    ? [ctx.state.inRound(ctx.ticket, actor.id, at), ""]
    : [true, " (the event has no time, so it is taken as in one)"];
}

const CLOSED = new Set<string>(["done", "canceled"]);

/**
 * The ticket's status as the event is judged by, and a note when that is not its status now. A comment written on an
 * open ticket that closed since is judged on the open ticket: one a human wrote just before closing it asked for
 * something. Only a close is looked behind: it is final, while any other move goes with an assignee judged as it is
 * now. A comment's time is the tracker's, the clock the close was read by.
 */
export function statusOf(ctx: Ctx, ticket: string): [CanonicalStatus | undefined, string] {
  const now = ctx.state.ticketStatus(ticket);
  const at = ctx.event.data["at"];
  if (ctx.event.type !== "ticket.commented" || typeof at !== "string" || !CLOSED.has(now ?? "")) {
    return [now, ""];
  }

  const then = ctx.state.ticketStatusAt(ticket, at);
  return then && !CLOSED.has(then) ? [then, ` when commented on (${now} now)`] : [now, ""];
}
