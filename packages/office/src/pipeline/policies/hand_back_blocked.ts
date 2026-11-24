import { definePolicy, type ActSpec } from "@outstaff/policy";
import { BLOCKED_HAND_BACK } from "./conditions.js";
import { HANDED_IN, withHandedIn } from "./hand-in.js";
import { handedOver, requesterOf, silentAgain, UNLESS_HANDED_OVER } from "./handover.js";
import { acts } from "./spec.js";
import { unblocker } from "./unblocker.js";

const toRequesterSpec: ActSpec = {
  as: "actor",
  ops: [{ move: "blocked" }, { assign: "requester" }],
};

const toRequester = acts(toRequesterSpec);

export const policy = definePolicy({
  id: "hand_back_blocked",
  summary:
    "A hand-back as blocked, or as done on a ticket the agent moved to blocked, on a team with no PM to unblock it (none, or the PM is the blocked agent), moves the ticket to blocked and gives it to the requester, for the agent, unless the agent handed the ticket over to someone else during the work. The work item's other tickets awaiting review (the ones it created that are in review, and the ones whose pull request it opened) go to review and to the requester.",
  on: ["agent.handed_back"],
  when: BLOCKED_HAND_BACK,
  decides: `${toRequester.decides}, when no PM unblocks it, ${UNLESS_HANDED_OVER}; ${HANDED_IN}`,
  decide: (_event, ctx) => {
    const pm = unblocker(ctx);
    if ("skip" in pm) {
      const to = requesterOf(ctx);
      const kept = handedOver(ctx, to);
      const blocked = kept.length > 0 ? kept : ctx.act(toRequesterSpec, silentAgain(ctx));
      return withHandedIn(ctx, blocked, to);
    }

    return [
      {
        type: "drop",
        reason: `the team's PM, ${pm.value}, unblocks it: hand_back_blocked_to_pm gives it to them`,
      },
    ];
  },
});
