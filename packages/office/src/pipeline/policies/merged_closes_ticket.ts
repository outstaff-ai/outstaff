import { definePolicy } from "@outstaff/policy";
import { UNFINISHED } from "./conditions.js";
import { acts } from "./spec.js";

export const policy = definePolicy({
  id: "merged_closes_ticket",
  summary:
    "A merge into the default branch closes the ticket for the author, unless another of its pull requests is open.",
  on: ["pr.merged"],
  when: {
    all: [
      { ticket_status: UNFINISHED },
      { pr_base_default: true },
      { not: { ticket_prs_open: true } },
    ],
  },
  instruction: "Moved to done: my pull request #{{pr.number}} merged.",
  ...acts({ as: "author", ops: [{ move: "done" }] }),
});
