import { definePolicy } from "@outstaff/policy";
import { NOT_BACKLOG, NOT_CLOSED } from "./conditions.js";
import { acts } from "./spec.js";

/** The rounds that work on a ticket. A chat session works on none: work a chat attaches runs as a round of these. */
const ROUNDS = [
  "assigned",
  "review_feedback",
  "ticket_comment",
  "rebase",
  "ci_failed",
  "merge_checks_failed",
];

export const policy = definePolicy({
  id: "start_marks_active",
  summary:
    "A round of work starting on a ticket assigns the ticket to the agent and moves it to active, for the agent. A round on a ticket in backlog (a comment or a mention on it) leaves its status and assignee alone: backlog is work for later, and only a human starts it, by moving the ticket on or by asking for the work in chat (a round from a chat request does start it).",
  on: ["agent.started"],
  when: {
    all: [{ work_kind: ROUNDS }, NOT_CLOSED, { any: [NOT_BACKLOG, { work_from_chat: true }] }],
  },
  ...acts({ as: "actor", ops: [{ assign: "self" }, { move: "active" }] }),
});
