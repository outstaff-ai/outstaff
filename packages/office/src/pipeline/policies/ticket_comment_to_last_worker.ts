import { definePolicy } from "@outstaff/policy";
import { BLOCKED_ON_AGENT, HUMAN } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "ticket_comment_to_last_worker",
  summary:
    "A human's comment, mentioning no agent, on a ticket handed back to a human (in review, or blocked with no agent blocked on it) wakes the agent who last worked on it.",
  on: ["ticket.commented"],
  when: {
    all: [
      HUMAN,
      { not: { agent_mentioned: true } },
      { assignee_kind: "human" },
      { ticket_status: ["review", "blocked"] },
      { not: BLOCKED_ON_AGENT },
    ],
  },
  instruction:
    "{{actor.id}} commented on {{ticket}}, which you handed back. Answer the comment on the ticket. If it needs more work, assign the ticket to yourself, move it to active and do the work.",
  ...wakes({ person: "last_worker", kind: "ticket_comment" }),
});
