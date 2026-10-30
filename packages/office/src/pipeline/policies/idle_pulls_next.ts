import { definePolicy } from "@outstaff/policy";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "idle_pulls_next",
  summary:
    "An agent with nothing queued or running is woken with its next ready ticket: the highest tracker priority, then the one ready the longest (policies.pull_ready).",
  on: ["agent.idle"],
  instruction:
    "You have nothing queued. Start {{next.ticket}}, the next ready ticket assigned to you. Work on it the way the repository asks.",
  ...wakes({ person: "actor", kind: "assigned", subject: "next_ready_ticket" }),
});
