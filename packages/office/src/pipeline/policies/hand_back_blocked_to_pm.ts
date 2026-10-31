import { definePolicy, type ActSpec, type WakeSpec } from "@outstaff/policy";
import { BLOCKED_HAND_BACK } from "./conditions.js";
import { handedOver, UNLESS_HANDED_OVER } from "./handover.js";
import { acts, wakes } from "./spec.js";
import { unblocker } from "./unblocker.js";

const toPm: ActSpec = {
  as: "actor",
  ops: [{ move: "blocked" }, { assign: "role:pm" }],
  note: "Moved to blocked and assigned to the team's PM to unblock: I handed the work back as blocked.",
};

const unblock: WakeSpec = { person: "role:pm", kind: "unblock" };

export const policy = definePolicy({
  id: "hand_back_blocked_to_pm",
  summary:
    "A hand-back as blocked, or as done on a ticket the agent moved to blocked, on a team with a PM other than the blocked agent, moves the ticket to blocked and gives it to the PM, for the agent, then wakes the PM to unblock it; unless the agent handed the ticket over to someone other than the PM during the work.",
  on: ["agent.handed_back"],
  when: BLOCKED_HAND_BACK,
  instruction:
    "{{actor.id}} handed {{ticket}} back as blocked, and it is assigned to you to unblock. Try everything before involving a human: answer from what you know, find the information, or ask the right teammate with `ost ask`. When it is unblocked, comment the answer on the ticket and assign it back to {{actor.id}}. Only if a human is needed, assign it to the requester, {{requester}}, with a comment that says exactly what is needed.",
  decides: `${acts(toPm).decides}; then ${wakes(unblock).decides}, when the PM is not the blocked agent, ${UNLESS_HANDED_OVER}`,
  decide: (_event, ctx) => {
    const pm = unblocker(ctx);
    if ("skip" in pm) {
      return [
        {
          type: "drop",
          reason: `no PM to unblock it (${pm.skip}): hand_back_blocked gives it to the requester`,
        },
      ];
    }

    const kept = handedOver(ctx, pm.value);
    return kept.length > 0 ? kept : [...ctx.act(toPm), ...ctx.wake(unblock)];
  },
});
