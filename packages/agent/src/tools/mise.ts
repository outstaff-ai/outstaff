import { execFile } from "node:child_process";
import type { MiseResult, MiseRunner } from "./types.js";

/** The real `mise` binary on PATH, with a generous timeout because the first install downloads toolchains. */
export const runMise: MiseRunner = (args, opts) =>
  new Promise<MiseResult>((resolve) => {
    execFile(
      "mise",
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }

        const e = error as NodeJS.ErrnoException & { code?: string | number };
        if (e.code === "ENOENT") {
          resolve({ code: 127, stdout, stderr: "mise is not installed in this image." });
          return;
        }

        resolve({
          code: typeof e.code === "number" ? e.code : 1,
          stdout,
          stderr: stderr || e.message,
        });
      },
    );
  });
