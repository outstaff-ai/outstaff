import {
  mergeGateChecks,
  mergeRepos,
  silentLogger,
  type ConfiguredAdapter,
  type DoctorCheck,
  type SecretSource,
  type TeamConfig,
  type Vcs,
} from "@outstaff/core";
import type { Context } from "#/types.js";

/**
 * The merge gate of every repo agents may merge, read from the code host with the office's vcs credentials: the host's
 * required checks and reviews are what stop an agent's pull request, so doctor reports a repo that requires neither.
 */
export async function mergeGateFindings(
  ctx: Context,
  team: TeamConfig,
  found: ConfiguredAdapter[],
  secrets: SecretSource,
): Promise<(DoctorCheck & { adapter: string })[]> {
  const vcs = found.find((f) => f.def.port === "vcs");
  if (!vcs || mergeRepos(team).length === 0) {
    return [];
  }

  let checks: DoctorCheck[];
  try {
    const port = (await vcs.def.create({
      options: vcs.def.options.parse(vcs.options),
      secrets,
      team,
      scope: "office",
      log: silentLogger,
      fetch: ctx.fetch ?? fetch,
      now: ctx.now ?? (() => new Date()),
    })) as Vcs;

    checks = await mergeGateChecks(team, port);
  } catch (e) {
    checks = [
      {
        name: "Merge gates",
        status: "fail",
        detail: `The merge requirements could not be read: ${(e as Error).message}`,
        fix: "Fix the error above and run again.",
      },
    ];
  }

  return checks.map((c) => ({ ...c, adapter: vcs.def.name }));
}
