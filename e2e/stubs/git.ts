import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUTHOR = {
  GIT_AUTHOR_NAME: "Ada Admin",
  GIT_AUTHOR_EMAIL: "ada@acme.example",
  GIT_COMMITTER_NAME: "Ada Admin",
  GIT_COMMITTER_EMAIL: "ada@acme.example",
};

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git and resolves with its exit code instead of rejecting: a merge conflict is an answer, not an error. */
export const git = (args: string[], cwd?: string, input?: string): Promise<GitResult> =>
  new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        ...(cwd ? { cwd } : {}),
        encoding: "utf8",
        env: { ...process.env, ...AUTHOR },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );

    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });

async function must(args: string[], cwd?: string, input?: string): Promise<string> {
  const r = await git(args, cwd, input);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
  }

  return r.stdout.trim();
}

/** A bare repository served over smart HTTP, with one commit on main. */
export class BareRepo {
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

  async init(files: Record<string, string>): Promise<void> {
    if (existsSync(this.dir)) {
      return;
    }

    mkdirSync(this.dir, { recursive: true });
    await must(["init", "--bare", "--initial-branch=main", this.dir]);
    await must(["config", "http.receivepack", "true"], this.dir);
    const work = mkdtempSync(join(tmpdir(), "seed-"));
    try {
      await must(["init", "--initial-branch=main", work]);
      for (const [path, text] of Object.entries(files)) {
        writeFileSync(join(work, path), text);
      }

      await must(["add", "-A"], work);
      await must(["commit", "-m", "Initial commit"], work);
      await must(["push", this.dir, "main"], work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** The commit a branch points at, or undefined. */
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

  /** Whether `head` merges into `base` without a conflict, decided by git itself. */
  async mergeable(base: string, head: string): Promise<boolean> {
    const r = await git(["merge-tree", "--write-tree", base, head], this.dir);
    return r.code === 0;
  }

  /** How many commits `head` has that `base` does not. */
  async ahead(base: string, head: string): Promise<number> {
    return Number(await must(["rev-list", "--count", `${base}..${head}`], this.dir));
  }

  /** Commits one file on a branch, as a person would with a clone of their own. */
  async commitFile(branch: string, path: string, text: string, message: string): Promise<void> {
    const work = mkdtempSync(join(tmpdir(), "edit-"));
    try {
      await must(["clone", "--branch", branch, this.dir, work]);
      writeFileSync(join(work, path), text);
      await must(["add", "-A"], work);
      await must(["commit", "-m", message], work);
      await must(["push", "origin", branch], work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
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

  async diff(base: string, head: string): Promise<string> {
    return must(["diff", `${base}...${head}`], this.dir);
  }

  /**
   * One request of git's smart HTTP protocol through `git http-backend`. The CGI answer is a header block, a blank
   * line and the body.
   */
  backend(opts: {
    method: string;
    path: string;
    query: string;
    contentType: string | undefined;
    encoding: string | undefined;
    body: Buffer;
    user: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          GIT_PROJECT_ROOT: this.root,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: opts.method,
          PATH_INFO: opts.path,
          QUERY_STRING: opts.query,
          CONTENT_TYPE: opts.contentType ?? "",
          CONTENT_LENGTH: String(opts.body.length),
          ...(opts.encoding ? { HTTP_CONTENT_ENCODING: opts.encoding } : {}),
          REMOTE_USER: opts.user,
          REMOTE_ADDR: "127.0.0.1",
          GIT_COMMITTER_NAME: AUTHOR.GIT_COMMITTER_NAME,
          GIT_COMMITTER_EMAIL: AUTHOR.GIT_COMMITTER_EMAIL,
        },
      });

      const out: Buffer[] = [];
      let err = "";
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => (err += String(c)));
      child.on("error", reject);
      child.on("close", () => {
        const all = Buffer.concat(out);
        const split = all.indexOf("\r\n\r\n");
        if (split < 0) {
          reject(new Error(`git http-backend gave no headers: ${err.trim()}`));
          return;
        }

        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of all.subarray(0, split).toString("utf8").split("\r\n")) {
          const colon = line.indexOf(":");
          const key = line.slice(0, colon).toLowerCase();
          const value = line.slice(colon + 1).trim();
          if (key === "status") {
            status = Number.parseInt(value, 10);
          } else {
            headers[key] = value;
          }
        }

        resolve({ status, headers, body: all.subarray(split + 4) });
      });

      child.stdin.end(opts.body);
    });
  }
}
