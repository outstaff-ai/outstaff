import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseRepoUrl, silentLogger } from "@outstaff/core";
import type { Offer } from "#/office-client/index.js";
import type { ClonedRepo, Workspaces, WorkspacesOptions } from "./types.js";
import { runGit } from "./git.js";

/** Where a repository states how work is done in it. */
export const CONVENTION_FILES = [
  "CONTRIBUTING.md",
  "AGENTS.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  ".github/pull_request_template.md",
] as const;

/** The convention files that exist in a worktree, then the configured extra files that exist. */
export function findConventionFiles(worktree: string, instructions: readonly string[] = []) {
  const isFile = (rel: string) => {
    try {
      return statSync(join(worktree, rel)).isFile();
    } catch {
      return false;
    }
  };

  return [...new Set([...CONVENTION_FILES, ...instructions])].filter(isFile);
}

/** Path-safe form of an item id. */
export const safeId = (id: string) => id.replaceAll(/[^\w.-]/g, "-").replace(/^\.+/, "_");

/** Item kinds that always start from the default branch. */
const STARTS_AFRESH = new Set<string>(["merged_feedback", "doc_feedback"]);

type Subject = Offer["context"]["subjects"][number];

const isOpenOwnPr = (s: Subject) =>
  s.type === "pr" && s.own === true && s.state === "open" && Boolean(s.headRef);

/**
 * The branch an item continues on instead of a new one: the head of the open pull request the person opened that the
 * item is about, either as its subject or as the only such pull request of its ticket. Undefined means new work, which
 * starts detached at the default branch; the agent creates the branch once it knows the work. A follow-up after a merge always starts afresh from the default branch.
 */
export function headBranchOf(offer: Offer): string | undefined {
  const { workItem: item, context } = offer;
  const subject = item.subject;
  if (STARTS_AFRESH.has(item.kind) || !subject) {
    return undefined;
  }

  const open = context.subjects.filter(isOpenOwnPr);
  if (subject.type === "pr") {
    return open.find((s) => s.ref === subject.ref)?.headRef;
  }

  if (subject.type === "ticket" && open.length === 1) {
    return open[0]!.headRef;
  }

  return undefined;
}

/** The repo an item is about: one named by a subject or link, else the primary repo or the first one that can be written. */
export function repoForItem(offer: Offer, repos: ClonedRepo[]): ClonedRepo | undefined {
  const urls = [
    ...offer.context.subjects.map((s) => s.url),
    ...offer.context.links.map((l) => l.url),
  ];

  for (const url of urls) {
    if (!url) {
      continue;
    }

    try {
      const ref = parseRepoUrl(url.replace(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+).*$/, "$1"));
      const hit = repos.find(
        (r) =>
          r.ref.host === ref.host &&
          r.ref.owner.toLowerCase() === ref.owner.toLowerCase() &&
          r.ref.name.toLowerCase() === ref.name.toLowerCase(),
      );

      if (hit) {
        return hit;
      }
    } catch {
      // Not a repository URL.
    }
  }

  const writable = repos.filter((r) => r.access === "write");
  return writable.find((r) => r.kind === "primary") ?? writable[0];
}

/** The names of the entries of a directory; none when it does not exist. */
const namesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

export function createWorkspaces(opts: WorkspacesOptions): Workspaces {
  const git = opts.git ?? runGit;
  const log = opts.log ?? silentLogger;
  const worktreeOf = (repo: string, id: string) => join(opts.layout.worktreesDir, repo, safeId(id));
  const scratchOf = (id: string) => join(opts.layout.scratchDir, safeId(id));
  const has = (cwd: string, ref: string) =>
    git(["show-ref", "--verify", "--quiet", ref], { cwd }).then(
      () => true,
      () => false,
    );

  const checkedOut = async (cwd: string, branch: string) =>
    (await git(["worktree", "list", "--porcelain"], { cwd }))
      .split("\n")
      .includes(`branch refs/heads/${branch}`);

  const space = (
    repo: ClonedRepo,
    worktree: string,
    branch: string | undefined,
    scratch: string,
  ) => ({
    repo: repo.name,
    worktree,
    branch,
    scratch,
    conventionFiles: findConventionFiles(worktree, repo.instructions),
  });

  return {
    async prepare(offer) {
      const item = offer.workItem;
      const repo = repoForItem(offer, opts.repos);
      if (!repo) {
        return undefined;
      }

      // Fetch first, so a branch someone else updated is built on and never overwritten.
      await git(["fetch", "--prune", "origin"], { cwd: repo.dir });

      const worktree = worktreeOf(repo.name, item.id);
      const scratch = scratchOf(item.id);
      mkdirSync(scratch, { recursive: true });

      if (existsSync(worktree)) {
        const current = (
          await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree })
        ).trim();

        return space(repo, worktree, current === "HEAD" ? undefined : current, scratch);
      }

      const head = headBranchOf(offer);
      mkdirSync(join(opts.layout.worktreesDir, repo.name), { recursive: true });
      await git(["worktree", "prune"], { cwd: repo.dir });

      if (!head) {
        // New work names no branch: the agent creates one, by the repository's conventions, once it has the work.
        await git(["worktree", "add", "--detach", worktree, `origin/${repo.defaultBranch}`], {
          cwd: repo.dir,
        });

        return space(repo, worktree, undefined, scratch);
      }

      // A branch can be checked out in one worktree only. When an earlier item that is still waiting holds the pull
      // request's head, this round gets a local branch of its own on the same commit and pushes to the head by name.
      let branch = head;
      if (await checkedOut(repo.dir, head)) {
        branch = `${head}-${safeId(item.id)}`;
        await git(["worktree", "add", "--no-track", "-B", branch, worktree, `origin/${head}`], {
          cwd: repo.dir,
        });

        return space(repo, worktree, branch, scratch);
      }

      if (await has(repo.dir, `refs/remotes/origin/${branch}`)) {
        await git(["worktree", "add", "--no-track", "-B", branch, worktree, `origin/${branch}`], {
          cwd: repo.dir,
        });
      } else if (await has(repo.dir, `refs/heads/${branch}`)) {
        await git(["worktree", "add", worktree, branch], { cwd: repo.dir });
      } else {
        await git(
          ["worktree", "add", "--no-track", "-b", branch, worktree, `origin/${repo.defaultBranch}`],
          { cwd: repo.dir },
        );
      }

      return space(repo, worktree, branch, scratch);
    },

    held() {
      const dirs = [
        opts.layout.scratchDir,
        ...opts.repos.map((r) => join(opts.layout.worktreesDir, r.name)),
      ];

      return [...new Set(dirs.flatMap(namesIn))];
    },

    async release(workItemId) {
      for (const repo of opts.repos) {
        const worktree = worktreeOf(repo.name, workItemId);
        if (!existsSync(worktree)) {
          continue;
        }

        try {
          await git(["worktree", "remove", "--force", worktree], { cwd: repo.dir });
          await git(["worktree", "prune"], { cwd: repo.dir });
        } catch (e) {
          log.warn("could not remove a worktree", {
            workItemId,
            worktree,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      rmSync(scratchOf(workItemId), { recursive: true, force: true });
    },
  };
}
