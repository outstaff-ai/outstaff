import { definePolicy } from "@outstaff/policy";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "doc_comment_to_mentioned_agent",
  summary:
    "An agent's comment on a document wakes the other agent it mentions. An agent's comment that mentions no other agent wakes no one.",
  on: ["doc.commented"],
  when: { all: [{ actor_kind: "agent" }, { agent_mentioned: true }] },
  instruction:
    "{{actor.id}} mentioned you in a comment on the document {{doc.title}}. Answer in the document and change it if needed.",
  ...wakes({ person: "mentioned", kind: "doc_feedback" }),
});
