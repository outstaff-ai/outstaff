import { definePolicy } from "@outstaff/policy";
import { HUMAN } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "doc_comment_to_agent",
  summary:
    "A human's comment on a document wakes the agent it mentions, else the agent who wrote it.",
  on: ["doc.commented"],
  when: HUMAN,
  instruction:
    "{{actor.id}} commented on the document {{doc.title}}. Answer in the document and change it if needed.",
  ...wakes({ person: ["mentioned", "doc_author"], kind: "doc_feedback" }),
});
