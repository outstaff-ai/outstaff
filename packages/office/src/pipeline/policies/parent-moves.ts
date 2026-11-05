import { openSubTickets } from "@outstaff/core";
import type { BookkeepingOp, PolicyContext, Proposal } from "@outstaff/policy";

/**
 * The agent a parent's move is made for: the one it is assigned to, else the one that last worked it, else the agent
 * of the closed sub-ticket.
 */
export function parentAgent(ctx: PolicyContext, parent: string): string | undefined {
  const assignee = ctx.state.assignee(parent);
  if (assignee?.kind === "agent") {
    return assignee.id;
  }

  const last = ctx.state.lastWorker(parent);
  if (last && ctx.options.people.includes(last)) {
    return last;
  }

  const agent = ctx.person(["assignee", "last_worker"]);
  return "skip" in agent ? undefined : agent.value;
}

/** The parent of the closed sub-ticket, or the drop when it still has open sub-tickets. */
export function lastClosed(ctx: PolicyContext): { parent: string } | { drop: Proposal } {
  const parent = ctx.state.parentOf(ctx.ticket!)!;
  const open = openSubTickets(ctx.state, parent);
  return open.length > 0
    ? { drop: { type: "drop", reason: `${parent} still has open sub-tickets: ${open.join(", ")}` } }
    : { parent };
}

/** Who has the parent next: its agent when it is done, else the requester (none when no human is known). */
function nextHolder(ctx: PolicyContext, parent: string, as: string, done: boolean) {
  if (done) {
    return { kind: "agent" as const, id: as };
  }

  const requester = ctx.state.requester(parent) ?? ctx.options.fallbackRequester;
  return requester ? { kind: "human" as const, id: requester } : undefined;
}

/** The changes that put the parent in `done` with its agent, or in `review` with the requester; none already made. */
export function finishOps(
  ctx: PolicyContext,
  parent: string,
  as: string,
  done: boolean,
): BookkeepingOp[] {
  const to = nextHolder(ctx, parent, as, done);
  const status = done ? ("done" as const) : ("review" as const);
  return [
    ...(ctx.state.ticketStatus(parent) === status
      ? []
      : [{ op: "move" as const, ticket: parent, to: status }]),
    ...(to && ctx.state.assignee(parent)?.id !== to.id
      ? [{ op: "assign" as const, ticket: parent, to }]
      : []),
  ];
}

const CLOSED = new Set(["done", "canceled"]);

/**
 * Whether the parent's work is all with the requester to review: every sub-ticket is done, canceled or in review, with
 * at least one in review, and each open pull request of its own is open for review, not a draft. The reason when not.
 */
export function inReviewWhole(ctx: PolicyContext, parent: string): { reason: string } | undefined {
  const subs = ctx.state.subTickets(parent);
  const status = (t: string) => ctx.state.ticketStatus(t) ?? "unknown";
  const outside = subs.filter((t) => !CLOSED.has(status(t)) && status(t) !== "review");
  if (outside.length > 0) {
    return {
      reason: `${parent} has sub-tickets not in review: ${outside.map((t) => `${t} is ${status(t)}`).join(", ")}`,
    };
  }

  if (!subs.some((t) => status(t) === "review")) {
    return { reason: `${parent} has no sub-ticket in review` };
  }

  const drafts = ctx.state.pullRequestsOf(parent).filter((p) => p.state === "open" && p.draft);
  return drafts.length > 0
    ? { reason: `${parent}'s own pull request is a draft: #${drafts[0]!.ref.number}` }
    : undefined;
}
