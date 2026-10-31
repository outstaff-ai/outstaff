import { readFileSync } from "node:fs";
import { parseTeamConfig, parseYaml, type TeamConfig } from "@outstaff/core";
import { configurePipeline } from "#/pipeline/configure.js";
import type { ReplaySetup } from "#/pipeline/replay/replay.types.js";

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
  // Its a Plan, the acme tracker, links pull requests on tickets.
  const pipeline = configurePipeline(team, [], ["tracker.development"]);
  return { policies: pipeline.policies, pipelineOptions: pipeline.options };
}
