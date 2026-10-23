import { execFile } from "node:child_process";

/** Runs git with the given arguments and resolves to its stdout. Rejects with git's message when it fails. */
export type RunGit = (args: string[], opts?: { cwd?: string }) => Promise<string>;

export const runGit: RunGit = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        // Credentials come from the helper only; git must never stop to ask on a terminal.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`git ${args[0] ?? ""} failed: ${stderr.trim() || error.message}`, {
              cause: error,
            }),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
