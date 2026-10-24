import { defineAdapter, type SecretSpec } from "@outstaff/core";
import { validateItsaplanIdentities } from "./identities.js";
import { createItsaplanKnowledge } from "./knowledge.js";
import { knowledgeOptions, trackerOptions } from "./options.js";
import { createItsaplanTracker } from "./tracker.js";

export { createItsaplanTracker, eventType } from "./tracker.js";
export { createItsaplanKnowledge } from "./knowledge.js";
export {
  knowledgeOptions,
  trackerOptions,
  type KnowledgeOptions,
  type TrackerOptions,
} from "./options.js";

export { docToMd, findRange, mdToDoc, plainText, type PmNode } from "./markdown.js";
export { ItsaplanHttp } from "./http.js";

const apiKey = (scope: "person" | "office"): SecretSpec[] => [
  {
    key: "ITSAPLAN_API_KEY",
    description:
      scope === "person"
        ? "API key of this agent's own member account in Its a Plan"
        : "API key of the member account the office acts as",
    where:
      "Its a Plan > Account settings > API keys, signed in as that member (the key is shown once)",
  },
];

export const itsaplanTracker = defineAdapter({
  port: "tracker",
  name: "itsaplan",
  capabilities: ["tracker.issues", "tracker.assign"],
  options: trackerOptions,
  secrets: apiKey,
  create: (ctx) => createItsaplanTracker(ctx),
  validateIdentities: validateItsaplanIdentities,
});

export const itsaplanKnowledge = defineAdapter({
  port: "knowledge",
  name: "itsaplan",
  capabilities: ["knowledge.docs"],
  options: knowledgeOptions,
  secrets: apiKey,
  create: (ctx) => createItsaplanKnowledge(ctx),
});
