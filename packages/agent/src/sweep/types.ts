import type { Logger } from "@outstaff/core";
import type { VolumeUsage } from "#/doctor/types.js";
import type { MeasureFolders } from "#/home/index.js";
import type { ClientClock, OfficeConnection } from "#/office-client/index.js";
import type { Workspaces } from "#/repos/index.js";
import type { ProgramRunner } from "#/tools/index.js";

export interface SweeperOptions {
  office: Pick<OfficeConnection, "workStatus" | "journal">;
  workspaces: Pick<Workspaces, "held" | "release" | "releaseIdle">;
  clock: ClientClock;
  log: Logger;

  /** Time between two sweeps. Default one day. */
  everyMs?: number;

  /**
   * Days a blocked or waiting item may go without a change before its workspace is swept, when nothing in it can be
   * lost (`agent.sweep.idle_days`). 0 keeps them. Default 7.
   */
  idleDays?: number;

  /** Prunes the tool and package caches after each sweep of the workspaces. None without it. */
  caches?: CachePruner;
}

/** Removes the worktrees and scratch folders of items the person no longer has work on, or has left idle. */
export interface Sweeper {
  /** Sweeps once. Resolves to the ids of the items whose worktree and scratch folder were removed. */
  sweep(): Promise<string[]>;

  /** Sweeps now, then once every `everyMs` until `stop`. A failed sweep is logged and tried again at the next one. */
  start(): void;
  stop(): void;
}

/** What one cache's prune freed. */
export interface PrunedCache {
  cache: string;
  freed: number;
}

export interface CachePrunerOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  log?: Logger;

  /** Runs mise, pnpm and npm. Defaults to the programs on PATH. */
  run?: ProgramRunner;

  /** Reads how full the home volume is. Defaults to statfs. */
  volume?: (path: string) => Promise<VolumeUsage>;
  measure?: MeasureFolders;
  now?: () => number;
}

export interface CachePruner {
  /** Prunes once and logs what it reclaimed in one line. Resolves to the caches it pruned. */
  prune(): Promise<PrunedCache[]>;
}
