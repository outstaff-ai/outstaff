import { definePolicy, type PolicyContext, type Proposal } from "@outstaff/policy";
import { finishOps, lastClosed, parentAgent } from "./parent-moves.js";

/** Whether the parent has an open pull request of its own: then the rest is for the requester to review. */
const hasOpenPr = (ctx: PolicyContext, parent: string) =>
  ctx.state.pullRequestsOf(parent).some((p) => p.state === "open");

/** Done, with its agent, when nothing of its own is open; else to review, with the requester; with the note. */
function close(ctx: PolicyContext, parent: string, as: string): Proposal {
  const done = !hasOpenPr(ctx, parent);
  const ops = finishOps(ctx, parent, as, done);
  if (ops.length === 0) {
    return { type: "drop", reason: `${parent} is in review with the requester already` };
  }

  const note = ctx.render(ctx.instruction!, { person: as });
  if ("skip" in note) {
    return { type: "drop", reason: `the note cannot be rendered: ${note.skip}` };
  }

  return {
    type: "act",
    as,
    ops,
    ...(note.value ? { note: note.value } : {}),
    reason: `the last open sub-ticket of ${parent} closed; ${done ? "it has no open pull request of its own" : "its own pull request is for the requester to review"}`,
  };
}

export const policy = definePolicy({
  id: "subtickets_closed_close_parent",
  summary:
    "The last open sub-ticket of a parent in review or blocked closing closes the parent, for the agent that last worked it, with a note listing the closed sub-tickets: to done, with the agent, when the parent has no open pull request of its own; otherwise to review, with the requester. A parent canceled or done is left alone.",
  on: ["ticket.closed"],
  when: {
    all: [{ ticket_status: ["done", "canceled"] }, { parent_status: ["review", "blocked"] }],
  },
  instruction:
    "{{ticket}} was the last open sub-ticket of {{parent}}. Its closed sub-tickets: {{parent.closed}}.",
  decides:
    "act for the parent's agent (the one it is assigned to, else the one that last worked it, else the closed sub-ticket's): move the parent to `done` and assign it to the agent, when it has no open pull request of its own, else to `review` and assign it to the requester; when the closed ticket was its last open sub-ticket",
  decide(_event, ctx) {
    const last = lastClosed(ctx);
    if ("drop" in last) {
      return [last.drop];
    }

    const as = parentAgent(ctx, last.parent);
    return as
      ? [close(ctx, last.parent, as)]
      : [{ type: "drop", reason: `no agent to act for on ${last.parent}` }];
  },
});
