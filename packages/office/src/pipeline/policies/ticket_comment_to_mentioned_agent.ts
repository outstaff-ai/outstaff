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
    "{{actor.id}} mentioned you in a comment on {{ticket}}. Read the comment and judge first whether anything in it is for you: a question you can answer, or an action that is yours. If something is, answer it, or do what it asks, on the ticket, once. A teammate's mention starts no new work: when an agent mentioned you, file no ticket and open no pull request for it (both are refused); propose the work to a trusted human on the ticket instead. If nothing is, end the round silently: no comment and no message; finish with `ost handback silent` and a one-line journal note. Never restate what someone else already said or asked. The ticket stays with its assignee: leave its assignee and status as they are, unless the comment asks you to take the ticket over.",
  ...wakes({ person: "mentioned", kind: "asked" }),
});
