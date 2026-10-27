import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger, SecretSource } from "@outstaff/core";
import type { z } from "zod";
import type { agentSdkOptions } from "./options.js";

/** The slice of the SDK's `query()` the adapter uses. Tests inject a fake. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export type AgentSdkOptions = z.infer<typeof agentSdkOptions>;

export interface AgentSdkRuntimeConfig {
  options: AgentSdkOptions;
  log?: Logger;

  /** Replaces the SDK's `query`; for tests. */
  query?: QueryFn;

  /** Starting point for the Claude Code process environment. Defaults to the process environment. */
  env?: Record<string, string | undefined>;

  /** Where the runtime credential is read from (files first, then `env`). Defaults to `envSecretSource(env)`. */
  secrets?: SecretSource;

  /** Every secret key any adapter declares; removed from the child's environment. */
  scrubKeys?: Iterable<string>;

  /** The folder of secret files. Defaults to `OUTSTAFF_SECRETS_DIR` in `env`, then `/run/secrets/outstaff`. */
  secretsDir?: string;
}

export interface MapState {
  lastText: string;
}

export interface SandboxProbe {
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface ProbeResult {
  /** Exit status; null when the command could not start or was killed. */
  status: number | null;
  stderr: string;

  /** Set when the command could not start, for example ENOENT. */
  errorCode?: string;
}

export type ProbeSpawn = (command: string, args: readonly string[]) => ProbeResult;

/** One recorded call to the fake `query` in testing.ts. */
export interface Call {
  prompt: string;
  options: Options;
}
