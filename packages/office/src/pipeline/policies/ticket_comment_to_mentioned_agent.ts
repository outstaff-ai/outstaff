import { definePolicy } from "@outstaff/policy";
import { NOT_CLOSED } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "ticket_comment_to_mentioned_agent",
  summary:
    "A comment on a ticket, by a human or another agent, wakes the agent it mentions first, to answer or act on it; the ticket stays with its assignee. An agent's comment that mentions no other agent wakes no one.",
  on: ["ticket.commented"],
  when: { all: [{ not: { actor_kind: "automation" } }, NOT_CLOSED, { agent_mentioned: true }] },
  instruction:
    "{{actor.id}} mentioned you in a comment on {{ticket}}. Read the comment and answer it, or do what it asks, on the ticket. The ticket stays with its assignee: leave its assignee and status as they are, unless the comment asks you to take the ticket over.",
  ...wakes({ person: "mentioned", kind: "asked" }),
});
