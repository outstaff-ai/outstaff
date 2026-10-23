import type { AdapterPort } from "./config/adapters.js";

export const CAPABILITIES = [
  "tracker.issues",
  "tracker.assign",
  "tracker.webhooks",
  "knowledge.docs",
  "vcs.pullRequests",
  "vcs.reviewThreads",
  "vcs.webhooks",
  "chat.messages",
  "chat.history",
  "chat.homeView",
  "runtime.sessions",
  "runtime.usage",
  "avatars.generate",
  "mail.inbox",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The port that provides each capability; the part before the dot. */
export const CAPABILITY_PORT: Record<Capability, AdapterPort> = {
  "tracker.issues": "tracker",
  "tracker.assign": "tracker",
  "tracker.webhooks": "tracker",
  "knowledge.docs": "knowledge",
  "vcs.pullRequests": "vcs",
  "vcs.reviewThreads": "vcs",
  "vcs.webhooks": "vcs",
  "chat.messages": "chat",
  "chat.history": "chat",
  "chat.homeView": "chat",
  "runtime.sessions": "runtime",
  "runtime.usage": "runtime",
  "avatars.generate": "avatars",
  "mail.inbox": "mail",
};
