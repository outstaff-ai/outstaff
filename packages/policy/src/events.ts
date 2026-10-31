import type { PipelineEventType } from "./events.types.js";

/** Every event the pipeline decides on: chat, code host, tracker, knowledge base and the office itself. */
export const PIPELINE_EVENT_TYPES = [
  "chat.message",
  "pr.opened",
  "pr.review_submitted",
  "pr.comment",
  "pr.merged",
  "pr.closed",
  "pr.conflicted",
  "pr.ci_failed",
  "pr.behind_base",
  "pr.base_merged",
  "ticket.commented",
  "ticket.assigned",
  "ticket.moved",
  "ticket.created",
  "doc.commented",
  "agent.started",
  "agent.handed_back",
  "agent.idle",
] as const;

/** Derived from a merge: the open pull requests of the repository that the merge changed something under. */
export const MERGE_DERIVED_TYPES = [
  "pr.conflicted",
  "pr.behind_base",
  "pr.base_merged",
] as const satisfies readonly PipelineEventType[];
