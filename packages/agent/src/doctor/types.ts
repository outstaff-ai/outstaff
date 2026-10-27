import type { DoctorCheck, TeamConfig } from "@outstaff/core";
import type { ToolStatus } from "#/tools/index.js";

/** How the network checks reach services; defaults to the real thing (the override is for tests). */
export interface NetworkProbes {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch | undefined;
}

/** Used and total bytes of a volume. */
export interface VolumeUsage {
  used: number;
  total: number;
}

/** What the agent checks about itself at start, to report to the office. */
export interface StartupChecksInput extends NetworkProbes {
  team: TeamConfig;
  person: TeamConfig["people"][number];
  home: string;

  /** How each declared tool fared at start. */
  tools: ToolStatus[];

  /** Reads the usage of the volume a path is on. Defaults to statfs. */
  volume?: ((path: string) => Promise<VolumeUsage>) | undefined;
}

/** Sends the checks to the office. */
export type DoctorReporter = (checks: DoctorCheck[]) => Promise<void>;
