import type { DoctorCheck, TeamConfig } from "@outstaff/core";
import type { Repositories } from "#/repos/index.js";
import type { ToolStatus } from "#/tools/index.js";
import type { AgentEnv } from "#/verbs/types.js";

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

  /** The ports the agent started with; the acts the office sends are made with its tracker port. */
  ports?: Pick<AgentEnv, "tracker" | "unavailable"> | undefined;

  /** The person's repositories, and the ones that could not be prepared at start. */
  repositories?: Pick<Repositories, "ready" | "unprepared"> | undefined;

  /** Whether an executable file is at a path. Defaults to the file system. */
  executable?: ((file: string) => boolean) | undefined;

  /** Reads the usage of the volume a path is on. Defaults to statfs. */
  volume?: ((path: string) => Promise<VolumeUsage>) | undefined;

  /** The largest folders of the home, for the fix line of a volume over the warning share. None without it. */
  homeBreakdown?: (() => Promise<string | undefined>) | undefined;
}

/** Sends the checks to the office. */
export type DoctorReporter = (checks: DoctorCheck[]) => Promise<void>;
