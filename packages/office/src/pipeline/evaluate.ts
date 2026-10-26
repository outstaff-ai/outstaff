import { createEvaluationContext } from "@outstaff/core";
import { awaitsReview } from "../engine/feedback.js";
import { evaluateCondition } from "./conditions.js";
import { decide } from "./decide.js";
import type { Decision } from "./decisions.types.js";
import type { PipelineEvent } from "./events.types.js";
import type { Policy } from "./policy.types.js";
import type { PipelineOptions, PipelineState } from "./state.types.js";
import type { PolicyTrace, Trace } from "./trace.types.js";

/** Why an event is not judged at all, or undefined. Both are what the engine skips today. */
function gate(event: PipelineEvent): string | undefined {
  if (event.data["untrusted"] === true) {
    return "the event comes from someone who is not trusted: recorded, never acted on";
  }

  return awaitsReview(event)
    ? "an inline comment of a review still pending: the submitted review brings it"
    : undefined;
}

function judge(
  policy: Policy,
  event: PipelineEvent,
  input: Parameters<typeof decide>[1],
): PolicyTrace {
  const base = { policy: policy.id, matched: false, decisions: [] };
  if (policy.enabled === false) {
    return { ...base, reason: "turned off" };
  }

  if (!policy.on.includes(event.type)) {
    return { ...base, reason: `listens to ${policy.on.join(", ")}, not ${event.type}` };
  }

  const c = policy.when
    ? evaluateCondition(policy.when, input.ctx)
    : { ok: true, detail: "no condition" };

  if (!c.ok) {
    return { ...base, reason: c.detail, failed: c.failed };
  }

  return { ...base, matched: true, reason: c.detail, decisions: [decide(policy, input)] };
}

/**
 * Judges an event against the ordered policies: every policy is evaluated and every one that matches contributes its
 * decision. Pure: the same inputs always give the same trace. An event no policy decides anything on is dropped.
 */
export function evaluatePipeline(
  event: PipelineEvent,
  state: PipelineState,
  policies: readonly Policy[],
  opts: PipelineOptions,
): Trace {
  const stopped = gate(event);
  if (stopped) {
    return { event, policies: [], decisions: [{ type: "drop", reason: stopped }] };
  }

  const ctx = createEvaluationContext(event, state, opts);
  const traces = policies.map((p) => judge(p, event, { event, ctx, state, opts }));
  const decisions: Decision[] = traces.flatMap((t) => t.decisions);
  return {
    event,
    policies: traces,
    decisions: decisions.length > 0 ? decisions : [{ type: "drop", reason: "no policy matched" }],
  };
}
