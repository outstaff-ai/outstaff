import { policyOn, resolveWorkflow, type TeamConfig } from "@outstaff/core";
import { DEFAULT_POLICIES, MERGE_ON_APPROVAL_POLICIES } from "./defaults.js";
import { instructionProblem } from "./instructions.js";
import type { Policy } from "./policy.types.js";
import type { ConfiguredPipeline } from "./state.types.js";

type Team = Pick<TeamConfig, "pipeline" | "policies" | "humans" | "workflow" | "people">;

/**
 * The team's policies: the defaults in order, with `pipeline.policies.<id>` applied. `enabled` turns one on or off,
 * `instruction` replaces a wake's text and `when` narrows it: both its own condition and the team's must hold.
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

  const mergeOnApproval = policyOn(team.policies, "merge.on_approval");
  const policies = DEFAULT_POLICIES.map((base): Policy => {
    const o = overrides[base.id];
    const p: Policy = {
      ...base,
      enabled: o?.enabled ?? (MERGE_ON_APPROVAL_POLICIES.has(base.id) ? mergeOnApproval : true),
    };

    if (o?.when) {
      p.when = p.when ? { all: [p.when, o.when] } : o.when;
    }

    if (o?.instruction !== undefined) {
      const problem =
        "wake" in base.decide ? instructionProblem(o.instruction) : "only a wake has one";

      if (problem) {
        issues.push(`pipeline.policies.${base.id}.instruction: ${problem}; the default is kept`);
      } else {
        p.instruction = o.instruction;
      }
    }

    return p;
  });

  const { options } = resolveWorkflow(team.workflow, team.humans, team.policies);
  return { policies, options: { ...options, people: team.people.map((p) => p.handle) }, issues };
}
