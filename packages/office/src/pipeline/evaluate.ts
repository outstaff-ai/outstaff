import type { ConfiguredPolicy, PipelineEvent } from "@outstaff/policy";
import { awaitsReview } from "#/work-feedback.js";
import { aggregate } from "./aggregate/aggregate.js";
import { publish } from "./bus.js";
import type { PipelineOptions, PipelineState } from "./state.types.js";
import type { Trace } from "./trace.types.js";

/** Why an event is not judged at all, or undefined: it is recorded, and nothing is decided on it. */
function gate(event: PipelineEvent): string | undefined {
  if (event.data["untrusted"] === true) {
    return "the event comes from someone who is not trusted: recorded, never acted on";
  }

  return awaitsReview(event)
    ? "an inline comment of a review still pending: the submitted review brings it"
    : undefined;
}

/**
 * Judges an event: the bus hands it to every policy that listens to it, each proposes, and the aggregation layer makes
 * the decisions. Pure: the same inputs always give the same trace. An event nothing is decided on is dropped.
 */
export function evaluatePipeline(
  event: PipelineEvent,
  state: PipelineState,
  policies: readonly ConfiguredPolicy[],
  options: PipelineOptions,
): Trace {
  const stopped = gate(event);
  if (stopped) {
    return {
      event,
      policies: [],
      aggregation: [],
      decisions: [{ type: "drop", reason: stopped }],
    };
  }

  const runs = publish(event, state, policies, options);
  const { decisions, aggregation } = aggregate(runs, policies, { event, options });
  return { event, policies: runs, aggregation, decisions };
}
