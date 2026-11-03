import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PortError } from "@outstaff/core";
import type { ClonedRepo, RunGit } from "./types.js";

/** The worktree that has `branch` checked out, if any: git checks a branch out in one worktree only. */
export async function holderOf(
  git: RunGit,
  cwd: string,
  branch: string,
): Promise<string | undefined> {
  let path: string | undefined;
  for (const line of (await git(["worktree", "list", "--porcelain"], { cwd })).split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line === `branch refs/heads/${branch}`) {
      return path;
    }
  }

  return undefined;
}

/**
 * Adds a worktree for `branch`: from the remote branch when it exists, else the local one, else a new branch from the
 * default branch. The caller made sure no other worktree has it checked out. Without a branch, detached at the
 * default branch.
 */
export async function addWorktree(
  git: RunGit,
  repo: Pick<ClonedRepo, "dir" | "defaultBranch">,
  worktree: string,
  branch: string | undefined,
): Promise<void> {
  const has = (ref: string) =>
    git(["show-ref", "--verify", "--quiet", ref], { cwd: repo.dir }).then(
      () => true,
      () => false,
    );

  const cwd = { cwd: repo.dir };
  if (!branch) {
    await git(["worktree", "add", "--detach", worktree, `origin/${repo.defaultBranch}`], cwd);
  } else if (await has(`refs/remotes/origin/${branch}`)) {
    await git(["worktree", "add", "--no-track", "-B", branch, worktree, `origin/${branch}`], cwd);
  } else if (await has(`refs/heads/${branch}`)) {
    await git(["worktree", "add", worktree, branch], cwd);
  } else {
    await git(
      ["worktree", "add", "--no-track", "-b", branch, worktree, `origin/${repo.defaultBranch}`],
      cwd,
    );
  }
}

/** The repo of the person's clones that `name` names: its short name, `owner/name` or a link. */
export function clonedRepo(repos: ClonedRepo[], name: string): ClonedRepo | undefined {
  const text = name
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

  return repos.find((r) => {
    const full = `${r.ref.owner}/${r.ref.name}`.toLowerCase();
    return (
      r.name.toLowerCase() === text ||
      text === full ||
      text.endsWith(`/${full}`) ||
      text.endsWith(`:${full}`)
    );
  });
}

/** Refuses a repository the person cannot write: no grant at all, or one their profile reads only. */
export function writableRepo(repos: ClonedRepo[], name: string): ClonedRepo {
  const repo = clonedRepo(repos, name);
  if (!repo) {
    const granted = repos.map((r) => r.name).join(", ") || "none";
    throw new PortError(
      "forbidden",
      `You have no grant on "${name}", so no worktree is added. The repositories you may use: ${granted}.`,
    );
  }

  if (repo.access !== "write") {
    throw new PortError(
      "forbidden",
      `You may only read ${repo.name}, so no worktree is added: changes there are for someone with a write grant on it.`,
    );
  }

  return repo;
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The item directory of a worktree under `<worktreesDir>/<repo>/`, when `path` is one. */
export function itemDirOf(worktreesDir: string, path: string): string | undefined {
  return real(dirname(dirname(path))) === real(worktreesDir) ? basename(path) : undefined;
}

/** The worktrees of the item, by repository, other than the one in `except`. */
export function otherWorktrees(
  worktreesDir: string,
  repos: Pick<ClonedRepo, "name">[],
  dir: string,
  except: string,
): { repo: string; worktree: string }[] {
  return repos
    .filter((r) => r.name !== except)
    .map((r) => ({ repo: r.name, worktree: join(worktreesDir, r.name, dir) }))
    .filter((w) => existsSync(w.worktree));
}

/** The names of the item directories under each repository's worktree folder. */
export function worktreeDirs(
  worktreesDir: string,
  repos: Pick<ClonedRepo, "name">[],
): { repo: string; dir: string; root: string }[] {
  return repos.flatMap((r) => {
    const parent = join(worktreesDir, r.name);
    return existsSync(parent)
      ? readdirSync(parent).map((dir) => ({ repo: r.name, dir, root: join(parent, dir) }))
      : [];
  });
}

/** Makes the folder a new worktree goes in. */
export const ensureParent = (worktree: string) => mkdirSync(dirname(worktree), { recursive: true });
