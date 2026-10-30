import type { ContextManifest } from "./context/context.types.js";
import type { Decision } from "./decisions.types.js";
import type { PipelineEvent } from "./events.types.js";
import type { PipelineCondition } from "./policy.types.js";

/** Where an act stands: the agent it is for makes its changes, so it waits while that agent is offline. */
export interface ActRecord {
  status: "queued" | "delivered" | "done" | "failed";
  queuedAt: string;

  /** When the act was last sent to the agent. */
  deliveredAt?: string | undefined;

  /** When the agent's answer came. */
  finishedAt?: string | undefined;

  /** One line per change the agent made, in order. */
  results: string[];

  /** The change that failed and why; the changes after it were not tried. */
  error?: string | undefined;
}

/** How one policy judged one event. */
export interface PolicyTrace {
  policy: string;
  matched: boolean;

  /** Why it matched or did not: the event types it listens to, that it is off, or the deciding condition's detail. */
  reason: string;

  /** For a policy that listens to the event but did not match: the first condition that failed. */
  failed?: PipelineCondition | undefined;
  decisions: Decision[];
}

/** Every policy evaluated for an event, in order, and every decision made. */
export interface Trace {
  event: PipelineEvent;
  policies: PolicyTrace[];
  decisions: Decision[];

  /** Each act's progress and, once the agent answered, what it did; by act id (`<event id>:<policy>`). */
  results?: Record<string, ActRecord> | undefined;

  /** What the bundle of each wake the event started carried, by work item id, once the item was offered. */
  context?: Record<string, ContextManifest> | undefined;
}

/** Where traces are kept; `id` is the event's id. */
export interface TraceStore {
  /** Replaces the event's trace; act results and wake contexts already recorded for it are kept. */
  record(trace: Trace): Promise<void>;
  get(id: string): Promise<Trace | undefined>;

  /** Newest event first; `before` is the time cursor of the next page. */
  list(query?: { before?: string; limit?: number }): Promise<Trace[]>;
}
