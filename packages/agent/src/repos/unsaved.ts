import type { RunGit } from "./types.js";

const fails = (p: Promise<unknown>) =>
  p.then(
    () => false,
    () => true,
  );

/** What `git status` lists: changes to tracked files, then untracked files. Ignored files are not listed. */
function changesIn(status: string): string | undefined {
  const lines = status.split("\n").filter(Boolean);
  if (lines.some((l) => !l.startsWith("??"))) {
    return "it has uncommitted changes";
  }

  return lines.length > 0 ? "it has untracked files" : undefined;
}

/** The ref a branch is pushed to: its upstream, else the remote branch of the same name. */
async function upstreamOf(git: RunGit, cwd: string, branch: string) {
  const configured = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd },
  ).then(
    (out) => out.trim(),
    () => "",
  );

  if (configured) {
    return configured;
  }

  const sameName = `refs/remotes/origin/${branch}`;
  return (await fails(git(["show-ref", "--verify", "--quiet", sameName], { cwd })))
    ? undefined
    : `origin/${branch}`;
}

async function unpushed(git: RunGit, cwd: string, branch: string) {
  const upstream = await upstreamOf(git, cwd, branch);
  if (!upstream) {
    return `branch ${branch} has no upstream`;
  }

  const ahead = Number((await git(["rev-list", "--count", `${upstream}..HEAD`], { cwd })).trim());
  return ahead > 0
    ? `branch ${branch} has ${ahead} commit(s) not pushed to ${upstream}`
    : undefined;
}

async function beyondBase(git: RunGit, cwd: string, defaultBranch: string) {
  const base = `origin/${defaultBranch}`;
  return (await fails(git(["merge-base", "--is-ancestor", "HEAD", base], { cwd })))
    ? `it has commits on no branch, beyond ${base}`
    : undefined;
}

/**
 * Why removing a worktree could lose work, or undefined when nothing can be lost: no uncommitted or untracked changes,
 * and every commit on the branch's upstream, or, with no branch, none beyond the default branch. A state git cannot
 * read is a reason too.
 */
export async function unsavedWork(
  git: RunGit,
  worktree: string,
  defaultBranch: string,
): Promise<string | undefined> {
  try {
    const cwd = worktree;
    const changes = changesIn(await git(["status", "--porcelain"], { cwd }));
    if (changes) {
      return changes;
    }

    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).trim();
    return branch === "HEAD"
      ? await beyondBase(git, cwd, defaultBranch)
      : await unpushed(git, cwd, branch);
  } catch (e) {
    return `its state could not be read: ${e instanceof Error ? e.message : String(e)}`;
  }
}
