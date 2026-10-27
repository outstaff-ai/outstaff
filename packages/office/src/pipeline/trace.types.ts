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
}

/** Where traces are kept; `id` is the event's id. */
export interface TraceStore {
  record(trace: Trace): Promise<void>;
  get(id: string): Promise<Trace | undefined>;

  /** Newest event first; `before` is the time cursor of the next page. */
  list(query?: { before?: string; limit?: number }): Promise<Trace[]>;
}
