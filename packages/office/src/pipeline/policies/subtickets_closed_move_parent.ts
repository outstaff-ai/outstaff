import { openSubTickets } from "@outstaff/core";
import {
  definePolicy,
  type BookkeepingOp,
  type PolicyContext,
  type Proposal,
} from "@outstaff/policy";

/** Whether the parent's own pull requests are all finished, with one merged: then the parent's work is done. */
function merged(ctx: PolicyContext, parent: string): boolean {
  const prs = ctx.state.pullRequestsOf(parent);
  return prs.some((p) => p.state === "merged") && prs.every((p) => p.state !== "open");
}

/** The parent's agent: the one it is assigned to, else the agent of the closed sub-ticket. */
function agentOf(ctx: PolicyContext, parent: string): string | undefined {
  const assignee = ctx.state.assignee(parent);
  if (assignee?.kind === "agent") {
    return assignee.id;
  }

  const agent = ctx.person(["assignee", "last_worker"]);
  return "skip" in agent ? undefined : agent.value;
}

/** Who has the parent next: its agent when it is done, else the requester (none when no human is known). */
function nextHolder(ctx: PolicyContext, parent: string, as: string, done: boolean) {
  if (done) {
    return { kind: "agent" as const, id: as };
  }

  const requester = ctx.state.requester(parent) ?? ctx.options.fallbackRequester;
  return requester ? { kind: "human" as const, id: requester } : undefined;
}

/** Done, with its agent, when its own pull requests merged; else to review, with the requester. */
function finish(ctx: PolicyContext, parent: string, as: string): Proposal {
  const done = merged(ctx, parent);
  const to = nextHolder(ctx, parent, as, done);
  const ops: BookkeepingOp[] = [
    { op: "move", ticket: parent, to: done ? "done" : "review" },
    ...(to && ctx.state.assignee(parent)?.id !== to.id
      ? [{ op: "assign" as const, ticket: parent, to }]
      : []),
  ];

  return {
    type: "act",
    as,
    ops,
    reason: `the last open sub-ticket of ${parent} closed; ${done ? "its own pull requests merged" : "the rest is for the requester to review"}`,
  };
}

export const policy = definePolicy({
  id: "subtickets_closed_move_parent",
  summary:
    "The last open sub-ticket of an active parent closing moves the parent on, for its agent: to done, with the agent, when the parent's own pull requests merged; otherwise to review, with the requester.",
  on: ["ticket.closed"],
  when: { all: [{ ticket_status: ["done", "canceled"] }, { parent_status: ["active"] }] },
  decides:
    "act for the parent's agent: move the parent to `done` and assign it to the agent, when its own pull requests merged, else to `review` and assign it to the requester; when the closed ticket was its last open sub-ticket",
  decide(_event, ctx) {
    const ticket = ctx.ticket!;
    const parent = ctx.state.parentOf(ticket)!;
    const open = openSubTickets(ctx.state, parent);
    if (open.length > 0) {
      return [{ type: "drop", reason: `${parent} still has open sub-tickets: ${open.join(", ")}` }];
    }

    const as = agentOf(ctx, parent);
    return as
      ? [finish(ctx, parent, as)]
      : [{ type: "drop", reason: `no agent to act for on ${parent}` }];
  },
});
