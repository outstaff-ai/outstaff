import { definePolicy } from "@outstaff/policy";
import { UNFINISHED } from "./conditions.js";
import { acts, TICKET_AGENT } from "./spec.js";

export const policy = definePolicy({
  id: "merged_closes_ticket",
  summary:
    "A merge into the default branch closes the ticket once the checks on its merge commit pass (or none start), unless another of its pull requests or one of its sub-tickets is open; the ticket ends with the agent who did the work: for the author, or, for a human's pull request, the agent the ticket is assigned to, else the agent who last worked on it.",
  on: ["pr.merge_checks_passed"],
  when: {
    all: [
      { ticket_status: UNFINISHED },
      { pr_base_default: true },
      { not: { ticket_prs_open: true } },
      { not: { open_subtickets: true } },
    ],
  },
  instruction:
    "Moved to done: pull request #{{pr.number}} by {{pr.author}} merged and the checks on its merge commit passed.",
  ...acts({ as: TICKET_AGENT, ops: [{ move: "done" }, { assign: "self" }] }),
});
