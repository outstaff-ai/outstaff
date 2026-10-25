import { PortError, type RepoRef } from "@outstaff/core";
import { runGit } from "../repos/git.js";
import { resolveRepo } from "./support.js";
import type { AgentEnv, VerbContext } from "./types.js";

const needCwd = (ctx: VerbContext, what: string): string => {
  if (!ctx.cwd) {
    throw new PortError("invalid", `Pass ${what}: there is no worktree to read it from here.`);
  }

  return ctx.cwd;
};

const git = async (cwd: string, args: string[], what: string): Promise<string> => {
  try {
    return (await runGit(args, { cwd })).trim();
  } catch (e) {
    throw new PortError("invalid", `Pass ${what}: ${cwd} is not a git worktree with it.`, {
      cause: e,
    });
  }
};

/** The repo named by `repo`, or else the one the worktree's `origin` points at. */
export async function repoOrWorktree(
  env: AgentEnv,
  ctx: VerbContext,
  repo: string | undefined,
): Promise<Required<RepoRef>> {
  if (repo) {
    return resolveRepo(env, repo);
  }

  const cwd = needCwd(ctx, "--repo");
  return resolveRepo(env, await git(cwd, ["remote", "get-url", "origin"], "--repo"));
}

/** The branch checked out in the worktree. Refuses a detached HEAD, which has no branch to open a pull request from. */
export async function currentBranch(ctx: VerbContext): Promise<string> {
  const cwd = needCwd(ctx, "--head");
  // Fails on a detached HEAD, and unlike rev-parse also on a branch without commits.
  try {
    return (await runGit(["symbolic-ref", "--short", "HEAD"], { cwd })).trim();
  } catch (e) {
    const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).catch(() => "");
    if (head.trim() === "HEAD") {
      throw new PortError(
        "invalid",
        "HEAD is detached, so there is no branch to open a pull request from. Name the branch first with git switch -c <name> (the repository's naming, else <type>/<ticket key>-<short slug>), push it, then open the pull request.",
        { cause: e },
      );
    }

    throw new PortError("invalid", `Pass --head: ${cwd} is not a git worktree with it.`, {
      cause: e,
    });
  }
}
