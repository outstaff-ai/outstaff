import { definePolicy } from "@outstaff/policy";
import { AGENT_PR_OPEN } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "ci_failed_to_author",
  summary: "Failing checks on an agent's open pull request wake its author.",
  on: ["pr.ci_failed"],
  when: AGENT_PR_OPEN,
  instruction:
    "Your pull request #{{pr.number}} ({{pr.title}}) {{pr.problem}}. The failing checks are in the feedback. Fix them and push.",
  ...wakes({ person: "author", kind: "ci_failed" }),
});
