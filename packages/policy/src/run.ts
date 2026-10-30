import { createPolicyContext } from "./context.js";
import { checkProposals } from "./define.js";
import type { ConfiguredPolicy, PolicyInput, PolicyRun } from "./policy.types.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One policy on one event: off, not listening, its `when` failing, or what `decide` proposed. A policy that throws, or
 * returns something that is not a list of proposals, is contained: the run carries an error proposal instead.
 */
export function runPolicy(policy: ConfiguredPolicy, input: PolicyInput): PolicyRun {
  const base = { policy: policy.id, matched: false, proposals: [] };
  if (policy.enabled === false) {
    return { ...base, reason: "turned off" };
  }

  const { event } = input;
  if (!policy.on.includes(event.type)) {
    return { ...base, reason: `listens to ${policy.on.join(", ")}, not ${event.type}` };
  }

  let matched = "no condition";
  try {
    if (policy.when) {
      const c = createPolicyContext(policy, input, matched).check(policy.when);
      if (!c.ok) {
        return { ...base, reason: c.detail, failed: c.failed };
      }

      matched = c.detail;
    }

    const proposals = checkProposals(
      policy.decide(event, createPolicyContext(policy, input, matched)),
    );

    return {
      ...base,
      matched: true,
      reason: matched,
      proposals:
        "value" in proposals ? proposals.value : [{ type: "error", reason: proposals.skip }],
    };
  } catch (error) {
    return {
      ...base,
      matched: true,
      reason: matched,
      proposals: [{ type: "error", reason: `threw: ${message(error)}` }],
    };
  }
}
