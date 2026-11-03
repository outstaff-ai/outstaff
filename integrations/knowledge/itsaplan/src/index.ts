import { defineAdapter } from "@outstaff/core";
import {
  deriveItsaplan,
  doctorItsaplan,
  itsaplanSecrets,
  itsaplanSetupGuide,
  optionalConnectionOptions,
} from "@outstaff/integration.shared.itsaplan";
import { docLinkCheck } from "./doctor.js";
import { notesCheck } from "./doctor-notes.js";
import { createItsaplanKnowledge } from "./knowledge.js";

export { createItsaplanKnowledge } from "./knowledge.js";
export { NOTES_ROOT } from "./notes.js";
export { docToMd } from "./doc-to-md.js";
export { mdToDoc } from "./markdown.js";
export { findRange, plainText } from "./text-range.js";
export type { KnowledgeOptions } from "./types.js";

/** The knowledge adapter's options: every one is optional and falls back to an Its a Plan tracker integration. */
export const knowledgeOptions = optionalConnectionOptions;

export const itsaplanKnowledge = defineAdapter({
  port: "knowledge",
  name: "itsaplan",
  capabilities: ["knowledge.docs", "knowledge.issueLinks", "knowledge.notes"],
  options: knowledgeOptions,
  secrets: itsaplanSecrets,
  create: (ctx) => createItsaplanKnowledge(ctx),
  setupGuide: itsaplanSetupGuide,
  derive: deriveItsaplan,
  doctor: (secrets, ctx) =>
    doctorItsaplan(secrets, ctx, async (api, c) => [
      ...(await docLinkCheck(api, c)),
      ...(await notesCheck(api, c)),
    ]),
});
