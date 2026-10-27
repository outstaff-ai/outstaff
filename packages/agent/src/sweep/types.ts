import type { Logger } from "@outstaff/core";
import type { ClientClock, OfficeConnection } from "#/office-client/index.js";
import type { Workspaces } from "#/repos/index.js";

export interface SweeperOptions {
  office: Pick<OfficeConnection, "workStatus" | "journal">;
  workspaces: Pick<Workspaces, "held" | "release">;
  clock: ClientClock;
  log: Logger;

  /** Time between two sweeps. Default one day. */
  everyMs?: number;
}

/** Removes the worktrees and scratch folders of items the person no longer has work on. */
export interface Sweeper {
  /** Sweeps once. Resolves to the ids of the items whose worktree and scratch folder were removed. */
  sweep(): Promise<string[]>;

  /** Sweeps now, then once every `everyMs` until `stop`. A failed sweep is logged and tried again at the next one. */
  start(): void;
  stop(): void;
}
