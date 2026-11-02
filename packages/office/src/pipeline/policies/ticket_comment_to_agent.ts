import { definePolicy } from "@outstaff/policy";
import { HUMAN, NOT_CLOSED } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "ticket_comment_to_agent",
  summary:
    "A human's comment, mentioning no agent, on a ticket assigned to an agent wakes that agent.",
  on: ["ticket.commented"],
  when: {
    all: [HUMAN, NOT_CLOSED, { not: { agent_mentioned: true } }, { assignee_kind: "agent" }],
  },
  instruction: "{{actor.id}} commented on {{ticket}}. Read the comment and act on it.",
  ...wakes({ person: "assignee", kind: "ticket_comment" }),
});
