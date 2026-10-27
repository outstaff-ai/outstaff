import { readFileSync } from "node:fs";
import { parseTeamConfig, parseYaml, resolveWorkflow, type TeamConfig } from "@outstaff/core";
import { configurePipeline } from "../../configure.js";
import type { ReplaySetup } from "../replay.types.js";

const FILE = new URL("../../../../../../examples/acme/.outstaff/team.yaml", import.meta.url);

/** The acme example team, with merging on approval turned on so the replay covers it. */
export function acmeTeam(): TeamConfig {
  const parsed = parseTeamConfig(parseYaml(readFileSync(FILE, "utf8")).value);
  if (!parsed.ok) {
    throw new Error("the acme example does not parse");
  }

  const team = parsed.config;
  return {
    ...team,
    policies: { ...team.policies!, merge: { ...team.policies!.merge, on_approval: true } },
  };
}

export function acmeSetup(): ReplaySetup {
  const team = acmeTeam();
  const workflow = resolveWorkflow(team.workflow, team.humans, team.policies);
  const pipeline = configurePipeline(team);
  return {
    rules: workflow.rules,
    workflowOptions: workflow.options,
    policies: pipeline.policies,
    pipelineOptions: pipeline.options,
    people: team.people.map((p) => p.handle),
    coalesceMs: 60_000,
  };
}
