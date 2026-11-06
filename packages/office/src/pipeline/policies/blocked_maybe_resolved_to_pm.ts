import { definePolicy, type WakeSpec } from "@outstaff/policy";
import { wakes } from "./spec.js";
import { unblocker } from "./unblocker.js";

const recheck: WakeSpec = { person: "role:pm", kind: "unblock" };

export const policy = definePolicy({
  id: "blocked_maybe_resolved_to_pm",
  summary:
    "Something a blocked ticket may wait on happened (a check that failed on its merge passes on the default branch while its work goes on, one of several linked blockers closes, or the human holding it writes about it on another ticket): the PM is woken on the ticket to check whether the block still holds. The work state raises it at most once per ticket and cause in 24 hours. Switch it off with `policies.recheck_blocked: false`.",
  on: ["ticket.block_maybe_resolved"],
  when: { ticket_status: ["blocked"] },
  instruction:
    "{{ticket}} is blocked, and something it may wait on happened: {{why}}. Check whether the block still holds. If it does not, unblock it: assign it back to the agent who works on it with a comment saying what changed, or, when its work is done, move it to done with a comment saying why. If it still holds, do nothing: change nothing, comment nothing, and hand back silent.",
  decides: `${wakes(recheck).decides}, when the team has a PM`,
  decide: (_event, ctx) => {
    const pm = unblocker(ctx);
    return "skip" in pm
      ? [{ type: "drop", reason: `no PM to look at the block (${pm.skip})` }]
      : ctx.wake(recheck);
  },
});
