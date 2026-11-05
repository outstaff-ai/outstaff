import { definePolicy, type PolicyContext, type Proposal } from "@outstaff/policy";
import { finishOps, inReviewWhole, parentAgent } from "./parent-moves.js";

/** The parent to review, with the requester, for its agent; or the drop that says why not. */
function toReview(ctx: PolicyContext, parent: string): Proposal {
  const not = inReviewWhole(ctx, parent);
  if (not) {
    return { type: "drop", reason: not.reason };
  }

  const as = parentAgent(ctx, parent);
  if (!as) {
    return { type: "drop", reason: `no agent to act for on ${parent}` };
  }

  return {
    type: "act",
    as,
    ops: finishOps(ctx, parent, as, false),
    reason: `every open sub-ticket of ${parent} is in review: the rest is for the requester to review`,
  };
}

export const policy = definePolicy({
  id: "subtickets_in_review_move_parent",
  summary:
    "A sub-ticket moving to review, or closing, moves an active parent to review and gives it to the requester, for the parent's agent, once every sub-ticket of it is done, canceled or in review, with at least one in review. A parent's own open pull request counts only once it is open for review, not a draft. When every sub-ticket closed, `subtickets_closed_move_parent` moves it instead.",
  on: ["ticket.moved", "ticket.closed"],
  when: {
    all: [
      {
        any: [{ moved_to: ["review"] }, { ticket_status: ["done", "canceled"] }],
      },
      { parent_status: ["ready", "active"] },
    ],
  },
  decides:
    "act for the parent's agent (the one it is assigned to, else the one that last worked it, else the sub-ticket's): move the parent to `review` and assign it to the requester; when every sub-ticket is done, canceled or in review, at least one in review, and no open pull request of its own is a draft",
  decide(_event, ctx) {
    return [toReview(ctx, ctx.state.parentOf(ctx.ticket!)!)];
  },
});
