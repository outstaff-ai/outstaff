import type { DoctorCheck } from "@outstaff/core";
import type { Repositories } from "#/repos/index.js";

/**
 * Whether the repositories the person has a grant on were prepared at start: one check per repository that was not,
 * with the error, or one ok check for all of them. None without repositories.
 */
export function repoChecks(
  repos: Pick<Repositories, "ready" | "unprepared"> | undefined,
): DoctorCheck[] {
  const failed = repos?.unprepared() ?? [];
  if (failed.length === 0) {
    const ready = repos?.ready ?? [];
    return ready.length
      ? [
          {
            name: "Repositories prepare",
            status: "ok",
            detail: `${ready.map((r) => r.name).join(", ")} cloned and fetched.`,
          },
        ]
      : [];
  }

  return failed.map((u) => ({
    name: `Repository ${u.name} prepares`,
    status: "fail",
    detail: `${u.name} could not be prepared: ${u.error}`,
    fix: `Check ${u.name}'s url in team.yaml and that the person's code host identity can reach it. The agent tries it again on \`ost worktree add\` and before work that needs it, without a restart.`,
  }));
}
