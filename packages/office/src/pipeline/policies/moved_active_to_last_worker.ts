import { definePolicy } from "@outstaff/policy";
import { HUMAN } from "./conditions.js";
import { acts } from "./spec.js";

export const policy = definePolicy({
  id: "moved_active_to_last_worker",
  summary:
    "A human moving a ticket assigned to a human to active, without the needs-human label, gives it back to the agent who last worked on it and wakes them.",
  on: ["ticket.moved"],
  when: {
    all: [
      HUMAN,
      { moved_to: ["active"] },
      { assignee_kind: "human" },
      { not: { has_label: "$needs_human" } },
    ],
  },
  instruction:
    "{{actor.id}} moved {{ticket}} to active and it is assigned to you again. Pick the work up.",
  ...acts({ as: "last_worker", ops: [{ assign: "self" }], wake: { kind: "assigned" } }),
});
