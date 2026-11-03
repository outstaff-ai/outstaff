import { definePolicy } from "@outstaff/policy";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "idle_pulls_next",
  summary:
    "An agent with nothing queued or running is woken with its next ready ticket: the highest tracker priority, then the one ready the longest (policies.pull_ready). For a sub-ticket of an open parent the agent is woken on the parent, so it takes the sub-tickets in the order it planned.",
  on: ["agent.idle"],
  instruction:
    "You have nothing queued. Your next ready work is {{next.ticket}}. Work on it the way the repository asks.",
  ...wakes({ person: "actor", kind: "assigned", subject: "next_ready_ticket" }),
});
