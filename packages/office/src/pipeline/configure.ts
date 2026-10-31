import { parseRepoUrl, policyOn, workflowOptions, type TeamConfig } from "@outstaff/core";
import { instructionProblem, type ConfiguredPolicy, type Policy } from "@outstaff/policy";
import { BUILT_IN_POLICIES, POLICY_SWITCH_OF } from "./policies/index.js";
import type { ConfiguredPipeline, PipelineOptions } from "./state.types.js";

type Team = Pick<TeamConfig, "pipeline" | "policies" | "humans" | "workflow" | "people" | "repos">;

type Override = NonNullable<NonNullable<Team["pipeline"]>["policies"]>[string];

/** The instruction a policy ends up with: the team's, if it can be used, else the policy's own. */
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

/** A policy with the team's changes to it. */
function applyOverride(
  base: ConfiguredPolicy,
  o: Override | undefined,
  on: boolean,
  issues: string[],
): ConfiguredPolicy {
  const when = whenOf(base, o);
  const instruction = instructionOf(base, o, issues);
  return {
    ...base,
    enabled: o?.enabled ?? on,
    ...(when ? { when } : {}),
    instruction,
  };
}

/** The custom policies whose ids are free: an id a built-in or an earlier custom policy has is an issue, and skipped. */
function customOf(custom: readonly ConfiguredPolicy[], issues: string[]): ConfiguredPolicy[] {
  const taken = new Set(BUILT_IN_POLICIES.map((p) => p.id));
  return custom.filter((p) => {
    if (taken.has(p.id)) {
      issues.push(
        `policies.custom: the id ${p.id} is taken by another policy; this one is not loaded`,
      );

      return false;
    }

    taken.add(p.id);
    return true;
  });
}

/** The repositories `policies.merge.repos` names, as lowercase `owner/name`; undefined when it names none. */
function mergeReposOf(team: Team): string[] | undefined {
  const names = team.policies?.merge.repos;
  if (!names) {
    return undefined;
  }

  return team.repos
    .filter((r) => names.includes(r.name))
    .map((r) => parseRepoUrl(r.url))
    .map((r) => `${r.owner}/${r.name}`.toLowerCase());
}

/** What the team's config tells the policies, and how long a wake waits for related ones. */
function optionsOf(team: Team): PipelineOptions {
  const seconds = team.pipeline?.wake?.coalesce_seconds;
  const mergeRepos = mergeReposOf(team);
  return {
    ...workflowOptions(team),
    people: team.people.map((p) => p.handle),
    ...(mergeRepos ? { mergeRepos } : {}),
    ...(seconds === undefined ? {} : { coalesceMs: seconds * 1000 }),
  };
}

/**
 * The team's policies: the built-in ones in order, then the custom ones `policies.custom` loaded, with
 * `pipeline.policies.<id>` applied. `enabled` turns one on or off, `instruction` replaces a wake's instruction or an
 * act's note, and `when` narrows it: both its own condition and the team's must hold.
 */
export function configurePipeline(
  team: Team,
  custom: readonly ConfiguredPolicy[] = [],
): ConfiguredPipeline {
  const overrides = team.pipeline?.policies ?? {};
  const issues: string[] = [];
  const all = [...BUILT_IN_POLICIES, ...customOf(custom, issues)];
  const known = new Set(all.map((p) => p.id));
  for (const id of Object.keys(overrides)) {
    if (!known.has(id)) {
      issues.push(`pipeline.policies.${id}: no policy has this id`);
    }
  }

  const switchedOn = (id: string) => {
    const path = POLICY_SWITCH_OF[id];
    return path === undefined || policyOn(team.policies, path);
  };

  const policies = all.map((base) =>
    applyOverride(base, overrides[base.id], switchedOn(base.id), issues),
  );

  return { policies, options: optionsOf(team), issues };
}
