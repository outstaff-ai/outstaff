import { execFile } from "node:child_process";
import type { GitResult } from "./e2e.types.js";

/** Who the commits the stand-in makes itself (seed, merges, edits on main) are by. */
export const AUTHOR = {
  GIT_AUTHOR_NAME: "Ada Admin",
  GIT_AUTHOR_EMAIL: "ada@acme.example",
  GIT_COMMITTER_NAME: "Ada Admin",
  GIT_COMMITTER_EMAIL: "ada@acme.example",
};

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

/** Runs git and resolves with its trimmed output; rejects when it fails. */
export async function must(args: string[], cwd?: string, input?: string): Promise<string> {
  const r = await git(args, cwd, input);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
  }

  return r.stdout.trim();
}
