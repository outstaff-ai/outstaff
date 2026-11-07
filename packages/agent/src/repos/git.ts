import { execFile } from "node:child_process";
import type { RunGit } from "./types.js";

/** The git command of the arguments, past the `-c` options: `fetch` in `-c a=b fetch origin`. */
const commandOf = (args: string[]) =>
  args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? "";

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
            new Error(`git ${commandOf(args)} failed: ${stderr.trim() || error.message}`, {
              cause: error,
            }),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
