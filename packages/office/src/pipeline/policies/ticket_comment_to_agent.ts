import { definePolicy } from "@outstaff/policy";
import { HUMAN, NOT_CLOSED } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "ticket_comment_to_agent",
  summary: "A human's comment on a ticket wakes the agent it mentions, else the agent assigned.",
  on: ["ticket.commented"],
  when: {
    all: [HUMAN, NOT_CLOSED, { any: [{ agent_mentioned: true }, { assignee_kind: "agent" }] }],
  },
  instruction: "{{actor.id}} commented on {{ticket}}. Read the comment and act on it.",
  ...wakes({ person: ["mentioned", "assignee"], kind: "ticket_comment" }),
});
