import { defineAdapter } from "@outstaff/core";
import {
  deriveItsaplan,
  doctorItsaplan,
  itsaplanSecrets,
  itsaplanSetupGuide,
  knowledgeOptions,
} from "@outstaff/integration.tracker.itsaplan";
import { createItsaplanKnowledge } from "./knowledge.js";

export { createItsaplanKnowledge } from "./knowledge.js";
export { docToMd, findRange, mdToDoc, plainText, type PmNode } from "./markdown.js";

export const itsaplanKnowledge = defineAdapter({
  port: "knowledge",
  name: "itsaplan",
  capabilities: ["knowledge.docs"],
  options: knowledgeOptions,
  secrets: itsaplanSecrets,
  create: (ctx) => createItsaplanKnowledge(ctx),
  setupGuide: itsaplanSetupGuide,
  derive: deriveItsaplan,
  doctor: doctorItsaplan,
});
