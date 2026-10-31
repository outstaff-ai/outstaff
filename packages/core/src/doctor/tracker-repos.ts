import type { TeamConfig } from "#/config/types.js";
import type { DoctorCheck } from "#/ports/adapter.js";
import { parseRepoUrl } from "#/ports/repo.js";
import type { RepoRef } from "#/ports/types.js";
import type { Tracker } from "#/ports/tracker.js";
import { writableRepos } from "./merge-gate.js";

const fullName = (repo: RepoRef) => `${repo.owner}/${repo.name}`.toLowerCase();

const FIX =
  "Connect the repository in the tracker's integrations, so the tracker can show agents' pull requests on their tickets.";

/** Whether the tracker can link the pull requests of one repo of the team file. */
function repoCheck(repo: TeamConfig["repos"][number], connected: Set<string>): DoctorCheck {
  const name = `Tracker link of ${repo.name}`;
  const full = fullName(parseRepoUrl(repo.url));
  return connected.has(full)
    ? { name, status: "ok", detail: `${full} is connected to the tracker.` }
    : {
        name,
        status: "warn",
        detail: `${full} is not connected to the tracker, so agents' pull requests in it are not shown on their tickets.`,
        fix: FIX,
      };
}

/**
 * For a tracker that links pull requests on tickets (`tracker.development`): whether each repository of the team file
 * that someone can write to is connected to it, so the pull requests opened in it can be linked. A read-only repo has
 * no pull requests of the team's to link, so it is not checked. A tracker without the capability has nothing to
 * check; one whose connections cannot be read leaves them not checked, saying why.
 */
export async function trackerRepoChecks(
  config: Pick<TeamConfig, "repos" | "people">,
  tracker: Pick<Tracker, "connectedRepositories"> | undefined,
): Promise<DoctorCheck[]> {
  const repos = writableRepos(config);
  if (!tracker?.connectedRepositories || repos.length === 0) {
    return [];
  }

  try {
    const connected = new Set((await tracker.connectedRepositories()).map(fullName));
    return repos.map((repo) => repoCheck(repo, connected));
  } catch (e) {
    return [
      {
        name: "Tracker links not checked",
        status: "warn",
        detail: `The repositories connected to the tracker could not be read: ${(e as Error).message}`,
        fix: "Run the doctor again once that is fixed; until then, agents' pull requests may not show on their tickets.",
      },
    ];
  }
}
