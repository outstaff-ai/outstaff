import { definePolicy } from "@outstaff/policy";
import { BLOCKED_ON_AGENT } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "unblocked_to_blocked_agent",
  summary:
    "A blocked ticket whose last open blocker was closed wakes the agent blocked on it, to check whether it can go on; the ticket stays where it is, since it may be blocked for other reasons too.",
  on: ["ticket.unblocked"],
  when: BLOCKED_ON_AGENT,
  instruction:
    "{{blocker}}, which blocked {{ticket}}, is closed, and no other ticket blocks it. You handed {{ticket}} back as blocked: check whether you can continue now. If so, assign it to yourself, move it to active and continue. Otherwise answer on the ticket what is still missing.",
  ...wakes({ person: "blocked_agent", kind: "unblocked" }),
});
