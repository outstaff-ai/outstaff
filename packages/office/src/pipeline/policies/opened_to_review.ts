import { definePolicy } from "@outstaff/policy";
import { acts, TICKET_AGENT } from "./spec.js";

export const policy = definePolicy({
  id: "opened_to_review",
  summary:
    "A pull request opened for review moves its ticket to review: for the author, or, for a human's pull request, the agent the ticket is assigned to, else the agent who last worked on it. A ticket with open sub-tickets stays active until the last one closes.",
  on: ["pr.opened"],
  when: {
    all: [
      { not: { pr_draft: true } },
      { ticket_status: ["backlog", "ready", "active"] },
      { not: { open_subtickets: true } },
    ],
  },
  instruction: "Moved to review: pull request #{{pr.number}} by {{pr.author}} is open for review.",
  ...acts({ as: TICKET_AGENT, ops: [{ move: "review" }] }),
});
