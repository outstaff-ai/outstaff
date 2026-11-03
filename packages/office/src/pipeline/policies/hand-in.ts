import type { CanonicalStatus } from "@outstaff/core";
import type { BookkeepingOp, PolicyContext, Proposal } from "@outstaff/policy";

const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Statuses a ticket waits in for its pull request to be opened for review. */
const BEFORE_REVIEW = new Set<CanonicalStatus | undefined>(["backlog", "ready", "active"]);

/**
 * The work item's other tickets the hand-back gives to `to` for review, as the hand-back event lists them: those the
 * item created that are in review, and those whose pull request the item opened, in review or on the way there. Only
 * a ticket that is still the agent's (assigned to it, or to nobody) or already with `to`: a hand-back never undoes a
 * hand-over. A ticket the item created for later, say in the backlog, is left alone.
 */
export function handedIn(ctx: PolicyContext, to: string | undefined): string[] {
  const { data } = ctx.event;
  const opened = new Set(keysOf(data["opened"]));
  const keys = new Set([...keysOf(data["created"]), ...opened]);
  keys.delete(ctx.ticket ?? "");
  return [...keys].filter((key) => {
    const status = ctx.state.ticketStatus(key);
    const assignee = ctx.state.assignee(key)?.id;
    const mine = !assignee || assignee === ctx.event.actor.id || assignee === to;
    return mine && (status === "review" || (opened.has(key) && BEFORE_REVIEW.has(status)));
  });
}

/** The changes that put each ticket in review, with `to`. */
function handInOps(ctx: PolicyContext, keys: string[], to: string): BookkeepingOp[] {
  return keys.flatMap((ticket): BookkeepingOp[] => [
    ...(ctx.state.ticketStatus(ticket) === "review"
      ? []
      : [{ op: "move" as const, ticket, to: "review" as const }]),
    ...(ctx.state.assignee(ticket)?.id === to
      ? []
      : [{ op: "assign" as const, ticket, to: { kind: "human" as const, id: to } }]),
  ]);
}

/**
 * A hand-back's proposals with the item's other tickets handed in as well: they go to review and to `to` (the
 * requester), in the same act as the item's own ticket, or in an act of their own for the agent when the item's ticket
 * needs no change. With no human to give them to, they stay as they are.
 */
export function withHandedIn(
  ctx: PolicyContext,
  proposals: readonly Proposal[],
  to: string | undefined,
): Proposal[] {
  const keys = to ? handedIn(ctx, to) : [];
  const ops = to ? handInOps(ctx, keys, to) : [];
  if (ops.length === 0) {
    return [...proposals];
  }

  const why = `the item's ${keys.join(", ")} handed in for review to ${to}`;
  const at = proposals.findIndex((p) => p.type === "act");
  const act = proposals[at];
  if (act?.type === "act") {
    return proposals.with(at, {
      ...act,
      ops: [...act.ops, ...ops],
      reason: `${act.reason}; ${why}`,
    });
  }

  // The agent who handed back: a hand-back's actor is always the agent.
  return [...proposals, { type: "act", as: ctx.event.actor.id, ops, reason: why }];
}

/** What a hand-back decides for the item's other tickets, in words for the reference. */
export const HANDED_IN =
  "the item's other tickets awaiting review (the ones it created that are in review, and the ones whose pull request it opened) move to `review` and go to the requester";
