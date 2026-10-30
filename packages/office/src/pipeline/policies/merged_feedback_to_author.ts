import { definePolicy } from "@outstaff/policy";
import { feedbackOn } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "merged_feedback_to_author",
  summary: "A human's review or comment on an agent's merged pull request wakes its author.",
  on: ["pr.review_submitted", "pr.comment"],
  when: feedbackOn({ pr_merged: true }),
  instruction:
    "{{actor.id}} commented on your merged pull request #{{pr.number}} ({{pr.title}}). Answer there. If they ask for a change, open a follow-up pull request.",
  ...wakes({ person: "author", kind: "merged_feedback" }),
});
