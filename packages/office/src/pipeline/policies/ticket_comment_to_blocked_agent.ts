import { definePolicy } from "@outstaff/policy";
import { BLOCKED_ON_AGENT, HUMAN } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "ticket_comment_to_blocked_agent",
  summary:
    "A comment on a blocked ticket, by a human or an agent other than the agent blocked on it, wakes the agent blocked on it; unless the ticket is with an agent (who is unblocking it), a human mentions an agent (that agent is woken), or an agent comments during its own round on the ticket.",
  on: ["ticket.commented"],
  when: {
    all: [
      BLOCKED_ON_AGENT,
      { not: { actor_kind: "automation" } },
      { not: { actor_is: "blocked_agent" } },
      { not: { assignee_kind: "agent" } },
      { not: { all: [HUMAN, { agent_mentioned: true }] } },
      { not: { actor_in_round: true } },
    ],
  },
  instruction:
    "{{actor.id}} commented on {{ticket}}, which you handed back as blocked. Read the comment. If it unblocks the work, assign the ticket to yourself, move it to active and continue. Otherwise answer on the ticket what is still missing.",
  ...wakes({ person: "blocked_agent", kind: "ticket_comment" }),
});
