import {
  maskSecrets,
  parseRepoUrl,
  PortError,
  repoKey,
  type Logger,
  type TeamConfig,
  type Vcs,
} from "@outstaff/core";
import { ProtocolError, type CiLogs } from "./protocol/index.js";

const NOT_A_CHECK =
  "is not the link of a check with a log on this code host. Pass the link of the failed check (for GitHub, the Actions job's link), from the wake or `ost pr checks`.";

/**
 * Answers the protocol's `ci_log`: the log of a check on one of the team's repositories, read with the office's own
 * code host credentials, so agents need no CI access. Any other repository is refused.
 */
export function officeCiLogs(deps: {
  vcs: Pick<Vcs, "checkLog" | "checkLink">;
  team: TeamConfig;
  log: Logger;
}): CiLogs {
  const { vcs, team, log } = deps;
  const repos = team.repos.map((r) => parseRepoUrl(r.url));
  const host = repos[0]?.host ?? "";
  const known = new Set(repos.map((r) => repoKey(r, host)));

  return {
    async read(person, request) {
      const found = vcs.checkLink?.(request.url);
      if (!found || !vcs.checkLog) {
        throw new ProtocolError("invalid", `${request.url} ${NOT_A_CHECK}`);
      }

      const label = `${found.repo.owner}/${found.repo.name}`;
      if (!known.has(repoKey(found.repo, host))) {
        throw new ProtocolError(
          "invalid",
          `${label} is not one of the team's repositories; the office reads check logs of those only.`,
        );
      }

      log.info("check log read for an agent", { person, repo: label, logId: found.logId });
      try {
        const { failedSteps } = await vcs.checkLog(found.repo, found.logId, {
          tail: request.lines,
        });

        return {
          repo: label,
          steps: failedSteps.map((s) => ({ ...s, lines: s.lines.map((l) => maskSecrets(l)) })),
        };
      } catch (error) {
        // The agent hears why: an unknown log, or the office App lacking Actions: read.
        if (error instanceof PortError) {
          throw new ProtocolError(
            error.code === "not_found" ? "not_found" : "failed",
            error.message,
          );
        }

        throw error;
      }
    },
  };
}
