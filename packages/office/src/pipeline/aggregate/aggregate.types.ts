import type { ErrorProposal, PipelineEvent, Proposal } from "@outstaff/policy";
import type { Decision } from "#/pipeline/decisions.types.js";
import type { AggregationOutcome } from "#/pipeline/trace.types.js";
import type { PipelineOptions } from "#/pipeline/state.types.js";

/** One proposal on its way through the aggregation, and what became of it. */
export interface Slot {
  policy: string;

  /** Its index in its policy's proposals. */
  index: number;

  /** Its place among all the event's proposals: policies in order, then each policy's proposals in order. */
  order: number;

  /** Its policy's priority, for conflicting acts. */
  priority: number;
  proposal: Proposal | ErrorProposal;
  outcome?: AggregationOutcome | undefined;
  reason?: string | undefined;

  /** The decision it becomes; none for an error, a suppression or a wake merged into another. */
  decision?: Decision | undefined;

  /** The wake it was merged into. */
  into?: Slot | undefined;
}

export interface AggregateInput {
  event: PipelineEvent;
  options: PipelineOptions;
}
