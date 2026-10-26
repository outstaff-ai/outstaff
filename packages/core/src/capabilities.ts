import type { AdapterPort } from "./config/types.js";
import type { Capability } from "./types.js";

export const CAPABILITIES = [
  "tracker.issues",
  "tracker.assign",
  "tracker.webhooks",
  "tracker.attachments",
  "knowledge.docs",
  "vcs.pullRequests",
  "vcs.reviewThreads",
  "vcs.workflows",
  "vcs.webhooks",
  "vcs.reactions",
  "vcs.merge",
  "chat.messages",
  "chat.history",
  "chat.agentProfile",
  "chat.files",
  "runtime.sessions",
  "runtime.usage",
  "avatars.generate",
  "design.canvas",
] as const;

/** The port that provides each capability; the part before the dot. */
export const CAPABILITY_PORT: Record<Capability, AdapterPort> = {
  "tracker.issues": "tracker",
  "tracker.assign": "tracker",
  "tracker.webhooks": "tracker",
  "tracker.attachments": "tracker",
  "knowledge.docs": "knowledge",
  "vcs.pullRequests": "vcs",
  "vcs.reviewThreads": "vcs",
  "vcs.workflows": "vcs",
  "vcs.webhooks": "vcs",
  "vcs.reactions": "vcs",
  "vcs.merge": "vcs",
  "chat.messages": "chat",
  "chat.history": "chat",
  "chat.agentProfile": "chat",
  "chat.files": "chat",
  "runtime.sessions": "runtime",
  "runtime.usage": "runtime",
  "avatars.generate": "avatars",
  "design.canvas": "runtime",
};
