import { definePolicy } from "@outstaff/policy";
import { NOT_BACKLOG, NOT_CLOSED, NOT_WAITING_ON_BLOCKERS } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "assigned_to_assignee",
  summary:
    "A ticket assigned to an agent, by anyone but that agent, wakes the agent. A ticket in backlog wakes no one either: it is planned for later, and its work starts when a human moves it to ready (the idle pull, `idle_pulls_next`) or to active (`moved_active_to_assignee`). A ticket that is blocked because a ticket that blocks it is still open wakes no one: `unblocked_to_ready` wakes the agent when its last blocker closes.",
  on: ["ticket.assigned", "ticket.created"],
  when: {
    all: [
      { assignee_kind: "agent" },
      { not: { actor_kind: "automation" } },
      { not: { actor_is: "assignee" } },
      NOT_CLOSED,
      NOT_BACKLOG,
      NOT_WAITING_ON_BLOCKERS,
    ],
  },
  instruction: "{{ticket}} is assigned to you. Work on it the way the repository asks.",
  ...wakes({ person: "assignee", kind: "assigned" }),
});
