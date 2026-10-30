import { policyOn, workflowOptions, type TeamConfig } from "@outstaff/core";
import { DEFAULT_POLICIES, POLICY_SWITCH_OF } from "./defaults.js";
import { instructionProblem } from "./instructions.js";
import type { Policy } from "./policy.types.js";
import type { ConfiguredPipeline } from "./state.types.js";

type Team = Pick<TeamConfig, "pipeline" | "policies" | "humans" | "workflow" | "people">;

type Override = NonNullable<NonNullable<Team["pipeline"]>["policies"]>[string];

/** The instruction a policy ends up with: the team's, if it can be used, else the default. */
function instructionOf(
  base: Policy,
  o: Override | undefined,
  issues: string[],
): string | undefined {
  if (o?.instruction === undefined) {
    return base.instruction;
  }

  const problem = instructionProblem(o.instruction);
  if (problem) {
    issues.push(`pipeline.policies.${base.id}.instruction: ${problem}; the default is kept`);
    return base.instruction;
  }

  return o.instruction;
}

/** A team's `when` narrows the policy's own: both must hold. */
const whenOf = (base: Policy, o: Override | undefined) => {
  if (!o?.when) {
    return base.when;
  }

  return base.when ? { all: [base.when, o.when] } : o.when;
};

/** A default policy with the team's changes to it. */
function applyOverride(
  base: Policy,
  o: Override | undefined,
  on: boolean,
  issues: string[],
): Policy {
  const when = whenOf(base, o);
  const instruction = instructionOf(base, o, issues);
  return {
    ...base,
    enabled: o?.enabled ?? on,
    ...(when ? { when } : {}),
    instruction,
  };
}

/**
 * The team's policies: the defaults in order, with `pipeline.policies.<id>` applied. `enabled` turns one on or off,
 * `instruction` replaces a wake's instruction or an act's note, and `when` narrows it: both its own condition and the team's must hold.
 */
export function configurePipeline(team: Team): ConfiguredPipeline {
  const overrides = team.pipeline?.policies ?? {};
  const issues: string[] = [];
  const known = new Set(DEFAULT_POLICIES.map((p) => p.id));
  for (const id of Object.keys(overrides)) {
    if (!known.has(id)) {
      issues.push(`pipeline.policies.${id}: no policy has this id`);
    }
  }

  const switchedOn = (id: string) => {
    const path = POLICY_SWITCH_OF[id];
    return path === undefined || policyOn(team.policies, path);
  };

  const policies = DEFAULT_POLICIES.map((base) =>
    applyOverride(base, overrides[base.id], switchedOn(base.id), issues),
  );

  const options = workflowOptions(team);
  return { policies, options: { ...options, people: team.people.map((p) => p.handle) }, issues };
}
