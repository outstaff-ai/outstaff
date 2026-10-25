import type { AdapterPort } from "./config/adapters.js";

export const CAPABILITIES = [
  "tracker.issues",
  "tracker.assign",
  "tracker.webhooks",
  "knowledge.docs",
  "vcs.pullRequests",
  "vcs.reviewThreads",
  "vcs.workflows",
  "vcs.webhooks",
  "vcs.reactions",
  "chat.messages",
  "chat.history",
  "chat.agentProfile",
  "runtime.sessions",
  "runtime.usage",
  "avatars.generate",
  "design.canvas",
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
  "vcs.workflows": "vcs",
  "vcs.webhooks": "vcs",
  "vcs.reactions": "vcs",
  "chat.messages": "chat",
  "chat.history": "chat",
  "chat.agentProfile": "chat",
  "runtime.sessions": "runtime",
  "runtime.usage": "runtime",
  "avatars.generate": "avatars",
  "design.canvas": "runtime",
};
