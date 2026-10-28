import type { ActOutcome } from "@outstaff/core";
import type { Comparison, EngineRecord } from "./compare/compare.types.js";
import type { ContextManifest } from "./context/context.types.js";
import type { Decision } from "./decisions.types.js";
import type { PipelineEvent } from "./events.types.js";
import type { PipelineCondition } from "./policy.types.js";

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

  /** What each executed act did, by act id (`<event id>:<policy>`), once its result is in. */
  results?: Record<string, ActOutcome> | undefined;

  /** In shadow mode: what the engine applied for the same event. */
  engine?: EngineRecord | undefined;

  /** In shadow mode: how the engine's outcome and the pipeline's compare. */
  comparison?: Comparison | undefined;

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
