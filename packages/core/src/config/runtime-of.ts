import type { TeamConfig } from "./types.js";

type Person = Pick<TeamConfig["people"][number], "runtime">;

/** The runtime a person runs on: their own `runtime`, else the team's `integrations.runtime`. */
export function runtimeOf(
  team: Pick<TeamConfig, "integrations">,
  person: Person | undefined,
): TeamConfig["integrations"]["runtime"] {
  return person?.runtime ?? team.integrations.runtime;
}

/** The team's integrations as one person sees them: `runtime` is that person's own. */
export function integrationsFor(
  team: Pick<TeamConfig, "integrations">,
  person: Person | undefined,
): TeamConfig["integrations"] {
  return { ...team.integrations, runtime: runtimeOf(team, person) };
}

/** The team as one person's container sees it, for everything that reads `integrations.runtime`. */
export function teamFor<T extends Pick<TeamConfig, "integrations">>(
  team: T,
  person: Person | undefined,
): T {
  return person?.runtime ? { ...team, integrations: integrationsFor(team, person) } : team;
}
