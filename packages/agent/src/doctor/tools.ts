import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { DoctorCheck } from "@outstaff/core";
import type { ToolStatus } from "#/tools/index.js";

/** How the declared tools fared when the agent installed them at start: one check per tool that is unavailable. */
export function toolStatusChecks(tools: ToolStatus[]): DoctorCheck[] {
  if (tools.length === 0) {
    return [];
  }

  const missing = tools.filter((t) => t.state === "unavailable");
  if (missing.length === 0) {
    return [
      {
        name: "Tools install",
        status: "ok",
        detail: `${tools.map((t) => `${t.name}@${t.version}`).join(", ")} installed.`,
      },
    ];
  }

  return missing.map((t) => ({
    name: `Tool ${t.name} installs`,
    status: "fail",
    detail: t.error ?? `${t.name}@${t.version} did not install.`,
    fix: `Check ${t.name}'s version and source under tools in team.yaml (or its toolset), and that the agent can reach the tool sources; then restart the agent.`,
  }));
}

/**
 * How the declared extensions of the tools fared at start: one failing check per extension that did not install,
 * with the CLI's reason, or one ok check for all of them. An extension that failed does not stop the agent.
 */
export function extensionChecks(tools: ToolStatus[]): DoctorCheck[] {
  const all = tools.flatMap((t) => t.extensions ?? []);
  if (all.length === 0) {
    return [];
  }

  const failed = all.filter((x) => x.state === "unavailable");
  if (failed.length === 0) {
    return [
      {
        name: "Tool extensions install",
        status: "ok",
        detail: `${all.map((x) => `${x.tool} ${x.extension}`).join(", ")} installed.`,
      },
    ];
  }

  return failed.map((x) => ({
    name: `Extension ${x.extension} of ${x.tool} installs`,
    status: "fail",
    detail: x.error ?? `${x.extension} did not install.`,
    fix: `Check the extension under tools.${x.tool}.extensions in team.yaml (its repository and pinned release tag or commit), that the person's App can read that repository and that the agent can reach it; then restart the agent.`,
  }));
}

/** Whether an executable file is at this path. */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Is each declared tool that installed on the PATH the agent's commands run with? A tool that did not install is
 * already reported by toolStatusChecks. One check per tool that is missing, or one ok check for all of them.
 */
export function toolPathChecks(
  tools: ToolStatus[],
  env: NodeJS.ProcessEnv,
  executable: (file: string) => boolean = isExecutable,
): DoctorCheck[] {
  const installed = tools.filter((t) => t.state !== "unavailable");
  if (installed.length === 0) {
    return [];
  }

  const dirs = (env["PATH"] ?? "").split(delimiter).filter(Boolean);
  const missing = installed.filter((t) => !dirs.some((d) => executable(join(d, t.name))));
  if (missing.length === 0) {
    return [
      {
        name: "Tools on PATH",
        status: "ok",
        detail: `${installed.map((t) => t.name).join(", ")} found on the PATH.`,
      },
    ];
  }

  return missing.map((t) => ({
    name: `Tool ${t.name} on PATH`,
    status: "fail",
    detail: `${t.name} is declared for this agent but is not on its PATH (${dirs.join(delimiter) || "empty"}), so its commands cannot run it.`,
    fix: `Check that the tool's program is named ${t.name} and that mise's shims directory (MISE_DATA_DIR/shims) is on the agent's PATH; then restart the agent.`,
  }));
}
