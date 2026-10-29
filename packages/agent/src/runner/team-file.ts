import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TeamConfig } from "@outstaff/core";

/**
 * Writes the team from the office where the agent's own child processes find it: `ost git-credential`, which git
 * starts as its credential helper, and `ost` verbs run from the agent's shell read `OUTSTAFF_TEAM_FILE`. The ejected
 * catalog path is made absolute, because the copy does not live next to it. Returns the file.
 */
export function shareTeamFile(
  env: NodeJS.ProcessEnv,
  home: string,
  team: TeamConfig,
  teamDir: string,
): string {
  const file = join(home, ".config", "outstaff", "team.json");
  const copy = { ...team, catalog: { ...team.catalog, path: resolve(teamDir, team.catalog.path) } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(copy, null, 2)}\n`, { mode: 0o644 });
  env["OUTSTAFF_TEAM_FILE"] = file;
  return file;
}
