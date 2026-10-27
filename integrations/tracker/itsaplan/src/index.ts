import { defineAdapter, type SecretSpec } from "@outstaff/core";
import { validateItsaplanIdentities } from "./identities.js";
import { doctorItsaplan } from "./doctor.js";
import { deriveItsaplan, itsaplanSetupGuide } from "./setup.js";
import { trackerOptions } from "./options.js";
import { createItsaplanTracker } from "./tracker.js";

export { createItsaplanTracker } from "./tracker.js";
export { eventType } from "./events.js";
export { knowledgeOptions, resolveConnection, trackerOptions } from "./options.js";
export type { ClientDeps, KnowledgeOptions, TrackerOptions } from "./types.js";

export { ItsaplanHttp } from "./http.js";

// The knowledge adapter (@outstaff/integration.knowledge.itsaplan) shares the client, cursor, setup and doctor.
export { createClient, type Itsaplan } from "./client.js";
export { nextCursor, OVERLAP_MS, parseCursor } from "./cursor.js";
export { doctorItsaplan } from "./doctor.js";
export { deriveItsaplan, itsaplanSetupGuide } from "./setup.js";

/** The secrets of both Its a Plan adapters: one member API key per container. */
export const itsaplanSecrets = (scope: "person" | "office"): SecretSpec[] => [
  {
    key: "ITSAPLAN_API_KEY",
    description:
      scope === "person"
        ? "API key of this agent's own member account in Its a Plan"
        : "API key of the member account the office acts as",
    where:
      "Its a Plan > Account settings > API keys, signed in as that member (the key is shown once)",
  },
  {
    key: "ITSAPLAN_MEMBER_ID",
    description: "Member id of the account the API key belongs to",
    where: "Let ost setup --derive look it up (/me)",
    derivable: true,
    optional: true,
  },
];

export const itsaplanTracker = defineAdapter({
  port: "tracker",
  name: "itsaplan",
  capabilities: ["tracker.issues", "tracker.assign", "tracker.attachments"],
  options: trackerOptions,
  secrets: itsaplanSecrets,
  create: (ctx) => createItsaplanTracker(ctx),
  validateIdentities: validateItsaplanIdentities,
  setupGuide: itsaplanSetupGuide,
  derive: deriveItsaplan,
  doctor: doctorItsaplan,
});
