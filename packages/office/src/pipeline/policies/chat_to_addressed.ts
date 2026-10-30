import { definePolicy } from "@outstaff/policy";
import { HUMAN } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "chat_to_addressed",
  summary: "A chat message wakes the agent it was written to.",
  on: ["chat.message"],
  when: HUMAN,
  instruction:
    "{{actor.id}} wrote to you in chat. Answer in the thread. If they ask for work, decide how it fits your queue.",
  ...wakes({ person: "addressed", kind: "chat" }),
});
