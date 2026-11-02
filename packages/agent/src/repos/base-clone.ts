import type { Logger } from "@outstaff/core";
import type {
  BaseClone,
  CloneRefresher,
  CloneRefresherOptions,
  RepoHead,
  RunGit,
} from "./types.js";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Moves a base clone's working tree to `origin/<default branch>`, detached, and resolves to where it is then. Nothing
 * works in a base clone (work happens in worktrees), so a clone with uncommitted changes to tracked files was changed
 * by hand: it is left as it is and reported. A detached checkout keeps every local branch, hook and config entry.
 */
export async function moveToDefault(git: RunGit, log: Logger, repo: BaseClone): Promise<RepoHead> {
  const cwd = repo.dir;
  const changed = (await git(["status", "--porcelain", "--untracked-files=no"], { cwd })).trim();
  let atDefault = false;
  if (changed) {
    log.warn("a base clone has local changes, so it was not moved to the default branch", {
      repo: repo.name,
      dir: cwd,
      changed: changed.split("\n").length,
    });
  } else {
    try {
      await git(["checkout", "--quiet", "--detach", `origin/${repo.defaultBranch}`], { cwd });
      atDefault = true;
    } catch (e) {
      log.warn("could not move a base clone to the default branch", {
        repo: repo.name,
        dir: cwd,
        error: reason(e),
      });
    }
  }

  const commit = (await git(["rev-parse", "HEAD"], { cwd })).trim();

  return { name: repo.name, commit, atDefault };
}

export function createCloneRefresher(opts: CloneRefresherOptions): CloneRefresher {
  const { git, log } = opts;
  const gap = opts.minFetchGapMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const fetchedAt = new Map<string, number>();
  const chains = new Map<string, Promise<unknown>>();

  function exclusive<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const run = (chains.get(dir) ?? Promise.resolve()).then(fn);
    chains.set(
      dir,
      run.catch(() => {}),
    );

    return run;
  }

  async function update(repo: BaseClone, { throttled = false } = {}) {
    const last = fetchedAt.get(repo.dir);
    if (!throttled || last === undefined || now() - last >= gap) {
      await git(["fetch", "--prune", "origin"], { cwd: repo.dir });
      fetchedAt.set(repo.dir, now());
    }

    return moveToDefault(git, log, repo);
  }

  return {
    exclusive,
    update,
    refresh: (repo, o) => exclusive(repo.dir, () => update(repo, o)),
  };
}
