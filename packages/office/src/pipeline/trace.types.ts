import type { PipelineEvent, PolicyRun } from "@outstaff/policy";
import type { ContextManifest } from "./context/context.types.js";
import type { Decision } from "./decisions.types.js";

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

/** How one policy judged one event: whether it matched, why, and what it proposed. */
export type PolicyTrace = PolicyRun;

/**
 * What the aggregation made of one proposal: `kept` (it is a decision), `merged` into another wake of the same person
 * and subject, `suppressed` by another policy, `rejected` by an invariant, `dropped` as pointless or by a conflict it
 * lost, or `error`, a policy that threw.
 */
export type AggregationOutcome =
  | "kept"
  | "merged"
  | "suppressed"
  | "rejected"
  | "dropped"
  | "error";

export interface AggregationEntry {
  policy: string;

  /** The proposal's index in its policy's `proposals`. */
  proposal: number;
  outcome: AggregationOutcome;

  /** Why, for every outcome but a plain `kept`. */
  reason?: string | undefined;

  /** The index in `decisions` of the decision it became, or was merged into. */
  decision?: number | undefined;
}

/** Every policy evaluated for an event, in order, what each proposed, what the aggregation made of it, and the decisions. */
export interface Trace {
  event: PipelineEvent;
  policies: PolicyTrace[];

  /** One entry per proposal, in the order the policies proposed them. */
  aggregation: AggregationEntry[];
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
