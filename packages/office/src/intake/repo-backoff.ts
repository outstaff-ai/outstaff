import { PortError, repoKey, type RepoRef } from "@outstaff/core";
import { clip } from "#/log.js";
import { backoffDelay } from "./backoff.js";
import type { RepoBackoff, RepoBackoffOptions } from "./types.js";

const name = (repo: RepoRef) => `${repo.owner}/${repo.name}`;

/** A repository that cannot be read, such as one the office App's installation does not cover; not the host failing. */
export const cannotRead = (error: unknown): error is PortError =>
  error instanceof PortError && (error.code === "not_found" || error.code === "forbidden");

/**
 * Backs off each repository that cannot be read on its own, so the others are still read on time. A failure is
 * logged once, when it happens; a repository waiting out its backoff is skipped quietly.
 */
export function createRepoBackoff(opts: RepoBackoffOptions): RepoBackoff {
  const { clock, logger, backoff, what } = opts;
  const failing = new Map<string, { failures: number; retryAt: number }>();

  return {
    due(repos) {
      const now = clock.now().getTime();
      return repos.filter((r) => (failing.get(repoKey(r))?.retryAt ?? now) <= now);
    },
    failed(repo, error) {
      const failures = (failing.get(repoKey(repo))?.failures ?? 0) + 1;
      const delay = backoffDelay(error, failures, backoff);
      failing.set(repoKey(repo), { failures, retryAt: clock.now().getTime() + delay });
      const code = error instanceof PortError ? error.code : "error";
      logger.warn(
        `${what} of ${name(repo)} failed (${code}), retrying in ${Math.round(delay / 1000)}s`,
        { repo: name(repo), code, retryInMs: delay, error: clip(String(error), 200) },
      );
    },
    read(repos) {
      for (const repo of repos.filter((r) => failing.delete(repoKey(r)))) {
        logger.info(`${what} of ${name(repo)} succeeded again`, { repo: name(repo) });
      }
    },
  };
}
