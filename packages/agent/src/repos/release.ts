import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@outstaff/core";
import type { ClonedRepo, CloneRefresher, IdleRelease, RunGit } from "./types.js";
import { unsavedWork } from "./unsaved.js";

/** In the worktree's own git folder, which goes with the worktree: the sweep already said why it keeps it. */
const KEPT_MARKER = "outstaff-kept";

interface ReleaseDeps {
  git: RunGit;
  log: Logger;
  repos: ClonedRepo[];
  clones: Pick<CloneRefresher, "exclusive">;
  worktreeOf: (repo: string, workItemId: string) => string;
  scratchOf: (workItemId: string) => string;

  /** When a round last prepared the item's worktrees (epoch ms), if it did since the agent started. */
  preparedAt: (workItemId: string) => number | undefined;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Removes an item's worktrees and scratch folder, and, for an idle item, only when nothing in them can be lost. */
export function createRelease(deps: ReleaseDeps) {
  const { git, log, clones } = deps;
  const held = (workItemId: string) =>
    deps.repos
      .map((repo) => ({ repo, worktree: deps.worktreeOf(repo.name, workItemId) }))
      .filter((w) => existsSync(w.worktree));

  /** Removes each worktree; stops, keeping the rest and the scratch folder, once `busy` says a round took the item. */
  async function remove(workItemId: string, busy: () => boolean): Promise<boolean> {
    for (const { repo, worktree } of held(workItemId)) {
      const removed = await clones
        .exclusive(repo.dir, async () => {
          if (busy()) {
            return false;
          }

          await git(["worktree", "remove", "--force", worktree], { cwd: repo.dir });
          await git(["worktree", "prune"], { cwd: repo.dir });
          return true;
        })
        .catch((e: unknown) => {
          log.warn("could not remove a worktree", { workItemId, worktree, error: message(e) });
          return true;
        });

      if (!removed) {
        return false;
      }
    }

    rmSync(deps.scratchOf(workItemId), { recursive: true, force: true });
    return true;
  }

  /** Marks each kept worktree; true when every one of them was marked already. */
  async function mark(kept: { worktree: string; reason: string }[]): Promise<boolean> {
    let noted = true;
    for (const { worktree, reason } of kept) {
      const dir = (await git(["rev-parse", "--absolute-git-dir"], { cwd: worktree })).trim();
      const marker = join(dir, KEPT_MARKER);
      if (!existsSync(marker)) {
        noted = false;
        writeFileSync(marker, `${reason}\n`);
      }
    }

    return noted;
  }

  async function releaseIdle(workItemId: string, since: number): Promise<IdleRelease> {
    const busy = () => (deps.preparedAt(workItemId) ?? -Infinity) >= since;
    if (busy()) {
      return { outcome: "in_use" };
    }

    const kept: { repo: string; worktree: string; reason: string }[] = [];
    for (const { repo, worktree } of held(workItemId)) {
      const reason = await unsavedWork(git, worktree, repo.defaultBranch);
      if (reason) {
        kept.push({ repo: repo.name, worktree, reason });
      }
    }

    if (kept.length > 0) {
      const noted = await mark(kept).catch(() => false);
      return {
        outcome: "kept",
        reasons: kept.map((k) => `${k.repo}: ${k.reason}`),
        noted,
      };
    }

    return (await remove(workItemId, busy)) ? { outcome: "released" } : { outcome: "in_use" };
  }

  return {
    release: (workItemId: string) => remove(workItemId, () => false).then(() => undefined),
    releaseIdle,
  };
}
