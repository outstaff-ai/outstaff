import { definePolicy } from "@outstaff/policy";
import { feedbackOn } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "review_to_author",
  summary: "A human's review or comment on an agent's open pull request wakes its author.",
  on: ["pr.review_submitted", "pr.comment"],
  when: feedbackOn({ pr_open: true }),
  instruction:
    "{{actor.id}} left feedback on your pull request #{{pr.number}} ({{pr.title}}). Address each point, answer in its thread and push.",
  ...wakes({ person: "author", kind: "review_feedback" }),
});
