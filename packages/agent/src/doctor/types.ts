import type { DoctorCheck, TeamConfig } from "@outstaff/core";
import type { ToolStatus } from "#/tools/index.js";

/** How the network checks reach services and devices; each defaults to the real thing (overrides are for tests). */
export interface NetworkProbes {
  env: NodeJS.ProcessEnv;

  /** The agent's home, where `ost adb connect` remembers wireless ports. */
  home?: string | undefined;
  fetch?: typeof fetch | undefined;
  tcpProbe?: ((host: string, port: number) => Promise<boolean>) | undefined;
  adbProbe?: (() => Promise<boolean>) | undefined;
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
