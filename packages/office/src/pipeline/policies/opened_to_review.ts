import { definePolicy } from "@outstaff/policy";
import { acts } from "./spec.js";

export const policy = definePolicy({
  id: "opened_to_review",
  summary: "A pull request opened for review moves its ticket to review, for the author.",
  on: ["pr.opened"],
  when: { all: [{ not: { pr_draft: true } }, { ticket_status: ["backlog", "ready", "active"] }] },
  instruction: "Moved to review: I opened pull request #{{pr.number}}.",
  ...acts({ as: "author", ops: [{ move: "review" }] }),
});
