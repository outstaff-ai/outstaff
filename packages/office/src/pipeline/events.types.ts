import type { ActorKind, PrRef } from "@outstaff/core";
import type { MERGE_DERIVED_TYPES, PIPELINE_EVENT_TYPES } from "./events.js";

/** Every event the pipeline decides on: chat, code host, tracker, knowledge base and the office itself. */
export type PipelineEventType = (typeof PIPELINE_EVENT_TYPES)[number];

/** Derived from a merge: the open pull requests of the repository that the merge changed something under. */
export type MergeDerivedType = (typeof MERGE_DERIVED_TYPES)[number];

/** The merged pull request that caused a derived event, so the woken agent knows what changed under it. */
export interface MergeCause {
  pr: PrRef;
  title: string;
  url?: string | undefined;
}

/** Where a chat message was written: the channel and, for a reply, the thread. */
export interface ChatRef {
  channel: string;
  thread?: string | undefined;
}

export interface PipelineSubject {
  ticket?: string;
  pr?: PrRef;
  doc?: string;
  chat?: ChatRef;
}

/**
 * One event, from any source. `data` carries what the event type says: `body`, `mentions` and `state` as intake
 * fills them for the conditions, `addressed` (an agent's handle) for `chat.message`, `cause` (a `MergeCause`) on
 * the merge-derived types, `status` and `kind` on `agent.handed_back`.
 */
export interface PipelineEvent {
  /** Unique per event: the office's `<source>:<externalId>`. */
  id: string;
  type: PipelineEventType;

  /** When it happened (ISO-8601). */
  at: string;
  subject: PipelineSubject;
  actor: { kind: ActorKind; id: string };
  data: Record<string, unknown>;
}
