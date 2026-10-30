import { createEvaluationContext, type Resolved, type TemplateError } from "@outstaff/core";
import { evaluateCondition } from "./conditions.js";
import { instructionVariables, renderInstruction } from "./instructions.js";
import { resolveSpec } from "./people.js";
import type { ConfiguredPolicy, PolicyContext, PolicyInput } from "./policy.types.js";
import { proposeAct, proposeWake } from "./propose.js";

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * The read-only view a policy decides with, for one event. `matched` says why the policy's `when` held. The state is
 * the office's; nothing the context offers changes it.
 */
export function createPolicyContext(
  policy: ConfiguredPolicy,
  input: PolicyInput,
  matched: string,
): PolicyContext {
  const ev = createEvaluationContext(input.event, input.state, input.options);
  const render = (text: string, extra: { person?: string; next?: string } = {}) => {
    try {
      return { value: renderInstruction(text, instructionVariables(ev, extra)) };
    } catch (error) {
      // Rendering throws only a TemplateError: an unknown variable or a malformed placeholder.
      return { skip: (error as TemplateError).message } satisfies Resolved<string>;
    }
  };

  const base = {
    event: input.event,
    state: input.state,
    options: input.options,
    ticket: ev.ticket,
    pr: ev.pr,
    settings: policy.settings ?? EMPTY,
    instruction: policy.instruction,
    matched,
    check: (condition: Parameters<PolicyContext["check"]>[0]) => evaluateCondition(condition, ev),
    person: (spec: Parameters<PolicyContext["person"]>[0]) => resolveSpec(spec, ev, input.options),
    render,
  };

  return Object.freeze({
    ...base,
    wake: (spec, reason) => proposeWake(base, spec, reason),
    act: (spec, reason) => proposeAct(base, spec, reason),
  } satisfies PolicyContext);
}
