import { definePolicy } from "@outstaff/policy";
import { NOT_CLOSED } from "./conditions.js";
import { acts } from "./spec.js";

/** The rounds that work on a ticket. A chat session works on none: work a chat attaches runs as a round of these. */
const ROUNDS = ["assigned", "review_feedback", "ticket_comment", "rebase", "ci_failed"];

export const policy = definePolicy({
  id: "start_marks_active",
  summary:
    "A round of work starting on a ticket assigns the ticket to the agent and moves it to active, for the agent.",
  on: ["agent.started"],
  when: { all: [{ work_kind: ROUNDS }, NOT_CLOSED] },
  instruction: "Assigned to me and moved to active: I started work on it.",
  ...acts({ as: "actor", ops: [{ assign: "self" }, { move: "active" }] }),
});
