import type { EffectiveTool, HostCli, Logger, ToolExtension } from "@outstaff/core";

/** How one declared tool fared at start. */
export interface ToolStatus {
  name: string;
  version: string;

  /** "installed" ran mise this start, "cached" reused an unchanged install, "unavailable" failed. */
  state: "installed" | "cached" | "unavailable";

  /** Why the tool is unavailable, in words an operator can act on. */
  error?: string;

  /** How the tool's declared extensions fared, when it declares any. */
  extensions?: ExtensionStatus[];
}

/** How one declared extension of a tool fared at start. */
export interface ExtensionStatus {
  tool: string;

  /** As declared, `owner/name@ref`. */
  extension: string;

  /** The command it adds to the tool; unknown when the extension cannot be one. */
  command?: string;

  /** "installed" ran the install this start, "cached" kept the one installed at the same ref, "unavailable" failed. */
  state: "installed" | "cached" | "unavailable";
  error?: string;
}

/** Runs the code host's CLI with `args`, with a fresh token for the call, and resolves to its exit code and output. */
export type RunExtensionInstall = (
  ext: ToolExtension,
  args: string[],
) => Promise<{ code: number; output: string }>;

export interface InstallExtensionsOptions {
  tools: EffectiveTool[];

  /** The code host's CLI; only it takes extensions. */
  cli: HostCli | undefined;
  home: string;

  /** The environment the CLI runs with, which decides where it keeps extensions. */
  env: NodeJS.ProcessEnv;
  run: RunExtensionInstall;
  log?: Logger;
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

/** Runs a program on PATH. A missing program is a result with code 127, not a throw. */
export type ProgramRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
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
