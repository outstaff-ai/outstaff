import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, must } from "./git-run.js";
import { httpBackend } from "./http-backend.js";
import type { GitHttpRequest, GitHttpResponse } from "./e2e.types.js";
import type { Mergeability, RepoBackend } from "./types.js";

/** Runs `fill` in a scratch directory that is removed afterwards. */
async function inScratch(prefix: string, fill: (work: string) => Promise<void>): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), prefix));
  try {
    await fill(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A bare repository on disk, served over smart HTTP; the stand-in's repository when it runs with git. */
export class BareRepo implements RepoBackend {
  readonly root: string;
  readonly owner: string;
  readonly name: string;
  readonly dir: string;

  constructor(root: string, owner: string, name: string) {
    this.root = root;
    this.owner = owner;
    this.name = name;
    this.dir = join(root, owner, `${name}.git`);
  }

  /** Creates the repository with one commit of `files` on main, unless it exists. */
  async init(files: Record<string, string>): Promise<void> {
    if (existsSync(this.dir)) {
      return;
    }

    mkdirSync(this.dir, { recursive: true });
    await must(["init", "--bare", "--initial-branch=main", this.dir]);
    await must(["config", "http.receivepack", "true"], this.dir);
    await inScratch("seed-", async (work) => {
      await must(["init", "--initial-branch=main", work]);
      for (const [path, text] of Object.entries(files)) {
        writeFileSync(join(work, path), text);
      }

      await must(["add", "-A"], work);
      await must(["commit", "-m", "Initial commit"], work);
      await must(["push", this.dir, "main"], work);
    });
  }

  async sha(ref: string): Promise<string | undefined> {
    const r = await git(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}^{commit}`],
      this.dir,
    );

    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async branches(): Promise<Record<string, string>> {
    const out = await must(
      ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"],
      this.dir,
    );

    return Object.fromEntries(
      out
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ") as [string, string]),
    );
  }

  /** Decided by git itself: whether `head` merges into `base` without a conflict. */
  async mergeable(base: string, head: string): Promise<Mergeability> {
    return (await this.conflicts(base, head)) ? "conflicting" : "clean";
  }

  async conflicts(base: string, head: string): Promise<boolean> {
    return (await git(["merge-tree", "--write-tree", base, head], this.dir)).code !== 0;
  }

  async ahead(base: string, head: string): Promise<number> {
    return Number(await must(["rev-list", "--count", `${base}..${head}`], this.dir));
  }

  /** Commits one file on a branch, as a person would with a clone of their own. */
  async commitFile(branch: string, path: string, text: string, message: string): Promise<void> {
    await inScratch("edit-", async (work) => {
      await must(["clone", "--branch", branch, this.dir, work]);
      writeFileSync(join(work, path), text);
      await must(["add", "-A"], work);
      await must(["commit", "-m", message], work);
      await must(["push", "origin", branch], work);
    });
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await git(["merge-base", "--is-ancestor", ancestor, descendant], this.dir)).code === 0;
  }

  /** Merges `head` into `base` with a merge commit, with no checkout. Fails when they conflict. */
  async merge(base: string, head: string, message: string): Promise<string> {
    const tree = await must(["merge-tree", "--write-tree", base, head], this.dir);
    const commit = await must(
      [
        "commit-tree",
        tree.split("\n")[0]!,
        "-p",
        await must(["rev-parse", base], this.dir),
        "-p",
        await must(["rev-parse", head], this.dir),
        "-m",
        message,
      ],
      this.dir,
    );

    await must(
      ["update-ref", `refs/heads/${base.replace(/^refs\/heads\//, "")}`, commit],
      this.dir,
    );

    return commit;
  }

  /** The three-dot diff, as GitHub serves a pull request's. */
  async diff(base: string, head: string): Promise<string> {
    return `${await must(["diff", `${base}...${head}`], this.dir)}\n`;
  }

  /** One request of git's smart HTTP protocol for this repository. */
  backend(req: GitHttpRequest): Promise<GitHttpResponse> {
    return httpBackend(this.root, req);
  }
}
