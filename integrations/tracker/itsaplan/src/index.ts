import { defineAdapter } from "@outstaff/core";
import {
  connectionOptions,
  deriveItsaplan,
  doctorItsaplan,
  itsaplanSecrets,
  itsaplanSetupGuide,
} from "@outstaff/integration.shared.itsaplan";
import { validateItsaplanIdentities } from "./identities.js";
import { createItsaplanTracker } from "./tracker.js";

export { createItsaplanTracker } from "./tracker.js";
export { eventType } from "./events.js";
export type { TrackerOptions } from "./types.js";

/** The tracker's options: the Its a Plan connection (the knowledge adapter falls back to them). */
export const trackerOptions = connectionOptions;

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
