import { definePolicy, type ActSpec } from "@outstaff/policy";
import { UNFINISHED } from "./conditions.js";
import { acts, TICKET_AGENT } from "./spec.js";

const close: ActSpec = { as: TICKET_AGENT, ops: [{ move: "done" }, { assign: "self" }] };

/** The note when the checks that failed on the merge commit passed later on the default branch. */
const RECOVERED = "Moved to done: {{recovered}}.";

export const policy = definePolicy({
  id: "merged_closes_ticket",
  summary:
    "A merge into the default branch closes the ticket once the checks on its merge commit pass (or none start, or the ones that failed pass later on a commit of the default branch that contains it), unless another of its pull requests or one of its sub-tickets is open; the ticket ends with the agent who did the work: for the author, or, for a human's pull request, the agent the ticket is assigned to, else the agent who last worked on it.",
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
  decides: `${acts(close).decides}; when the checks that failed on the merge commit passed later on a commit of the default branch that contains it, the note says which, where and on what commit`,
  decide: (event, ctx) =>
    ctx.act(event.data["recoveredOn"] ? { ...close, note: RECOVERED } : close),
});
