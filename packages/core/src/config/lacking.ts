import type { Capability } from "#/types.js";

/** What an agent cannot do without a capability, completing "<role> <handle> cannot ...". */
export const LACKING: Record<Capability, string> = {
  "tracker.issues": "read or update tickets",
  "tracker.assign": "be assigned tickets",
  "tracker.webhooks": "react to ticket changes instantly",
  "tracker.attachments": "attach files to tickets",
  "tracker.development": "link its pull requests on their tickets",
  "knowledge.docs": "write design docs",
  "vcs.pullRequests": "open or update pull requests",
  "vcs.reviewThreads": "reply to review threads",
  "vcs.workflows": "push changes to CI workflow files",
  "vcs.webhooks": "react to repository changes instantly",
  "vcs.reactions": "react to pull request comments",
  "vcs.merge": "merge pull requests",
  "chat.messages": "send chat messages",
  "chat.history": "read earlier chat messages",
  "chat.agentProfile": "show the agent's profile and status in chat",
  "chat.files": "read files shared in chat",
  "runtime.sessions": "keep sessions between runs",
  "runtime.usage": "track LLM usage against limits",
  "runtime.permissions": "run under its permission policy",
  "avatars.generate": "get a generated avatar",
  "design.canvas": "work on a Design canvas",
};
