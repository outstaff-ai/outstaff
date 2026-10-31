import { definePolicy } from "@outstaff/policy";
import { handedOver, requesterOf, UNLESS_HANDED_OVER } from "./handover.js";
import { acts } from "./spec.js";

const toReview = acts({ as: "actor", ops: [{ move: "review" }, { assign: "requester" }] });

export const policy = definePolicy({
  id: "hand_back_done",
  summary:
    "A hand-back as done moves the ticket to review and gives it to the requester, for the agent, unless the agent handed the ticket over to someone else during the work.",
  on: ["agent.handed_back"],
  when: {
    all: [
      { hand_back_status: ["done"] },
      { not: { ticket_status: ["blocked", "done", "canceled"] } },
    ],
  },
  instruction: "Moved to review and assigned to the requester: I handed the work back as done.",
  decides: `${toReview.decides}, ${UNLESS_HANDED_OVER}`,
  decide: (event, ctx) => {
    const kept = handedOver(ctx, requesterOf(ctx));
    return kept.length > 0 ? kept : toReview.decide(event, ctx);
  },
});
