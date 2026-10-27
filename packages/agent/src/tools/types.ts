import type { EffectiveTool, Logger } from "@outstaff/core";

/** How one declared tool fared at start. */
export interface ToolStatus {
  name: string;
  version: string;

  /** "installed" ran mise this start, "cached" reused an unchanged install, "unavailable" failed. */
  state: "installed" | "cached" | "unavailable";

  /** Why the tool is unavailable, in words an operator can act on. */
  error?: string;
}

export interface MiseResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the `mise` binary. A missing binary is a result with code 127, not a throw. */
export type MiseRunner = (
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<MiseResult>;

export interface InstallToolsOptions {
  tools: EffectiveTool[];
  home: string;
  env?: NodeJS.ProcessEnv;
  mise?: MiseRunner;
  log?: Logger;
}

export interface InstallToolsResult {
  statuses: ToolStatus[];

  /** Where mise puts its shims; put it on PATH for the runtime's child processes. */
  shimsDir: string;
}
