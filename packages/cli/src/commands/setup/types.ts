import type { SecretSource, SetupStep, TeamConfig } from "@outstaff/core";
import type { Context } from "#/types.js";
import type { AnyDef, Scope } from "#/commands/types.js";

export interface Configured {
  def: AnyDef;
  options: unknown;
}

export interface DeriveReport {
  written: string[];
  warnings: string[];
}

/** One `ost setup --derive` run: where secrets are read and written, and what it reports. */
export interface DeriveRun {
  ctx: Context;
  team: TeamConfig;
  scope: Scope;
  person: TeamConfig["people"][number] | undefined;
  dir: string;
  yes: boolean;
  secrets: SecretSource;
  report: DeriveReport;
}

export type SetupOptions = {
  out?: string;
  derive?: boolean;
  secretsDir?: string;
  yes?: boolean;
};

/** What `ost setup` works on: the scope, where its files go, and the adapters configured for it. */
export interface SetupPlan {
  config: TeamConfig;

  /** The directory of the team file. */
  teamDir: string;
  scope: Scope;

  /** The handle, or "office". */
  target: string;
  person: TeamConfig["people"][number] | undefined;

  /** The project directory `.outstaff/...` goes into. */
  out: string;
  secretsDir: string;

  /** The `.env` file of the scope, relative to `out`. */
  envFile: string;
  found: Configured[];
  unknown: string[];
}

export type SetupGuide = { adapter: string; steps: SetupStep[] };
