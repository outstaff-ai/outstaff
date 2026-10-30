import { definePolicy } from "@outstaff/policy";
import { HUMAN } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "moved_active_to_assignee",
  summary: "A human moving a ticket to active wakes the agent assigned.",
  on: ["ticket.moved"],
  when: { all: [HUMAN, { moved_to: ["active"] }, { assignee_kind: "agent" }] },
  instruction: "{{actor.id}} moved {{ticket}} to active. Pick the work up.",
  ...wakes({ person: "assignee", kind: "assigned" }),
});
