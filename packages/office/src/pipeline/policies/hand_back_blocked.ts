import { definePolicy } from "@outstaff/policy";
import { BLOCKED_HAND_BACK } from "./conditions.js";
import { acts } from "./spec.js";
import { unblocker } from "./unblocker.js";

const toRequester = acts({ as: "actor", ops: [{ move: "blocked" }, { assign: "requester" }] });

export const policy = definePolicy({
  id: "hand_back_blocked",
  summary:
    "A hand-back as blocked, or as done on a ticket the agent moved to blocked, on a team with no PM to unblock it (none, or the PM is the blocked agent), moves the ticket to blocked and gives it to the requester, for the agent.",
  on: ["agent.handed_back"],
  when: BLOCKED_HAND_BACK,
  instruction: "Moved to blocked and assigned to the requester: I handed the work back as blocked.",
  decides: `${toRequester.decides}, when no PM unblocks it`,
  decide: (event, ctx) => {
    const pm = unblocker(ctx);
    return "skip" in pm
      ? toRequester.decide(event, ctx)
      : [
          {
            type: "drop",
            reason: `the team's PM, ${pm.value}, unblocks it: hand_back_blocked_to_pm gives it to them`,
          },
        ];
  },
});
