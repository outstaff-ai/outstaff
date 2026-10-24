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

/** The branch checked out in the worktree. */
export async function currentBranch(ctx: VerbContext): Promise<string> {
  // Fails on a detached HEAD, and unlike rev-parse also on a branch without commits.
  return git(needCwd(ctx, "--head"), ["symbolic-ref", "--short", "HEAD"], "--head");
}
