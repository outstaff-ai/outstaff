import { definePolicy, type PolicyContext, type Proposal } from "@outstaff/policy";
import { finishOps, lastClosed, parentAgent } from "./parent-moves.js";

/** Whether the parent's own pull requests are all finished, with one merged: then the parent's work is done. */
function merged(ctx: PolicyContext, parent: string): boolean {
  const prs = ctx.state.pullRequestsOf(parent);
  return prs.some((p) => p.state === "merged") && prs.every((p) => p.state !== "open");
}

/** Done, with its agent, when its own pull requests merged; else to review, with the requester. */
function finish(ctx: PolicyContext, parent: string, as: string): Proposal {
  const done = merged(ctx, parent);
  return {
    type: "act",
    as,
    ops: finishOps(ctx, parent, as, done),
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
    const last = lastClosed(ctx);
    if ("drop" in last) {
      return [last.drop];
    }

    const as = parentAgent(ctx, last.parent);
    return as
      ? [finish(ctx, last.parent, as)]
      : [{ type: "drop", reason: `no agent to act for on ${last.parent}` }];
  },
});
