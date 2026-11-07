import { execFile } from "node:child_process";
import { join } from "node:path";
import type { EffectiveTool } from "@outstaff/core";
import type { MiseResult, MiseRunner, ProgramRunner } from "./types.js";

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

/**
 * Runs a program on PATH (mise, or a tool whose shim mise put there) and resolves to its exit code and output. A
 * missing program is a result with code 127, not a throw. The default timeout is generous because mise's first install
 * downloads toolchains.
 */
export const runProgram: ProgramRunner = (file, args, opts) =>
  new Promise<MiseResult>((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 30 * 60 * 1000,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }

        const e = error as NodeJS.ErrnoException & { code?: string | number };
        if (e.code === "ENOENT") {
          resolve({ code: 127, stdout, stderr: `${file} is not installed in this image.` });
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

/** The real `mise` binary on PATH. */
export const runMise: MiseRunner = (args, opts) => runProgram("mise", args, opts);
