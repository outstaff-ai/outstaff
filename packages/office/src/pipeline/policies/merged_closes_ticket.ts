import { definePolicy } from "@outstaff/policy";
import { UNFINISHED } from "./conditions.js";
import { acts, TICKET_AGENT } from "./spec.js";

export const policy = definePolicy({
  id: "merged_closes_ticket",
  summary:
    "A merge into the default branch closes the ticket, unless another of its pull requests is open: for the author, or, for a human's pull request, the agent the ticket is assigned to, else the agent who last worked on it.",
  on: ["pr.merged"],
  when: {
    all: [
      { ticket_status: UNFINISHED },
      { pr_base_default: true },
      { not: { ticket_prs_open: true } },
    ],
  },
  instruction: "Moved to done: pull request #{{pr.number}} by {{pr.author}} merged.",
  ...acts({ as: TICKET_AGENT, ops: [{ move: "done" }] }),
});
