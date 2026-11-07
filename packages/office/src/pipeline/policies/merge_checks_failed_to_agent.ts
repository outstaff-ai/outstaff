import { definePolicy } from "@outstaff/policy";
import { wakes, TICKET_AGENT } from "./spec.js";

export const policy = definePolicy({
  id: "merge_checks_failed_to_agent",
  summary:
    "A check that fails on the merge commit of a pull request in the default branch, such as a deploy, wakes the ticket's agent with the failed step's log: the pull request's author, or, for a human's pull request, the agent the ticket is assigned to, else the agent who last worked on it. The ticket stays open.",
  on: ["pr.merge_checks_failed"],
  when: { all: [{ pr_merged: true }, { not: { ticket_status: ["canceled"] } }] },
  instruction:
    "Pull request #{{pr.number}} ({{pr.title}}) by {{pr.author}} merged, but checks on its merge commit failed: {{checks}}. The end of the failed step's log is in the context; `ost ci log <check link>` reads more. Fix it the way the repository asks, for example with a follow-up pull request on the same ticket. The ticket stays open until a merge for it passes its checks. If the context lists a pull request of yours since the failure that already fixes it, do not fix it again: hand back silent, saying which one.",
  ...wakes({ person: TICKET_AGENT, kind: "merge_checks_failed" }),
});
