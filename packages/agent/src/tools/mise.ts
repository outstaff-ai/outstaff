import { execFile } from "node:child_process";
import { join } from "node:path";
import type { EffectiveTool } from "@outstaff/core";
import type { MiseResult, MiseRunner } from "./types.js";

/** The mise key of a tool: its explicit source, else its name (mise's registry). */
export const miseKey = (t: EffectiveTool) => t.source ?? t.name;

/** Where mise keeps its installs and shims. */
export const dataDirOf = (home: string, env: NodeJS.ProcessEnv) =>
  env["MISE_DATA_DIR"] ?? join(home, ".local/share/mise");

/** The reason mise gave, without its progress bars, version footer and hints. */
export const lastLine = (r: { stderr: string; stdout: string }) => {
  const lines = `${r.stderr}\n${r.stdout}`
    .split("\n")
    .map((l) => l.replace(/^mise (ERROR|WARN)\s+/, "").trim())
    .filter((l) => l && !/█|^Version:|^Run with|^hint:|^deprecated/.test(l));

  const failed = lines.filter((l) => /failed|error|not found|not installed/i.test(l));
  return (failed.length ? failed : lines).slice(0, 2).join(" ") || "no output";
};

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
