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
export { docToMd } from "./doc-to-md.js";
export { mdToDoc } from "./markdown.js";
export { findRange, plainText } from "./text-range.js";
export type { PmNode } from "./types.js";

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
