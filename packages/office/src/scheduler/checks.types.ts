import type { Logger, TeamConfig } from "@outstaff/core";
import type { Run, Store, WorkItem } from "#/store/types.js";
import type { Clock } from "#/types.js";
import type { MoveTarget, RetryPolicy, RunBlock, UsageWindow } from "./policy.types.js";
import type { BlockNotice, UsageSource } from "./types.js";

export interface ChecksOptions {
  store: Store;
  team: Pick<TeamConfig, "policies">;
  clock: Clock;
  log: Logger;
  usage: UsageSource | undefined;
  maxRuns: number;
  chatSessions: number;

  /** The start-time check (`SchedulerOptions.stopped`). */
  stopped?: ((item: WorkItem) => Promise<string | undefined>) | undefined;
}

/** The scheduler's reads of the store and its policy checks, shared by its operations. */
export interface Checks {
  /**
   * Whether the person has room to start the item: a chat session needs a free session, other work an idle lane and the
   * chat session that filed it ended, and a merge also no other merge running in its repository.
   */
  hasRoom(
    item: Pick<WorkItem, "id" | "person" | "kind" | "subject" | "parentId">,
  ): Promise<boolean>;

  /** Why the person has no room for the item, for the refusal to start it. */
  busyDetail(item: WorkItem): Promise<string>;

  /** Another item's merge running in the repository of a merge item, which it waits for. */
  mergeRunning(item: Pick<WorkItem, "id" | "kind" | "subject">): Promise<WorkItem | undefined>;
  backingOff(item: Pick<WorkItem, "notBefore">): boolean;
  getWindows(person: string): Promise<UsageWindow[]>;
  pauseBlock(person: string): Promise<RunBlock | null>;
  usageBlock(
    person: string,
    item: Pick<WorkItem, "trigger">,
    windows?: UsageWindow[],
  ): Promise<RunBlock | null>;
  guardTripped(item: WorkItem): Promise<string | null>;
  openRun(itemId: string): Promise<Run | undefined>;
  blockItem(item: WorkItem, reason: string, code: BlockNotice["code"]): Promise<BlockNotice>;
  queuedOf(person: string): Promise<WorkItem[]>;
  applyMove(itemId: string, target: MoveTarget): Promise<void>;

  /** Cancels a queued item the start-time check stops, with the reason in its journal; the reason, when it did. */
  stop(item: WorkItem): Promise<string | undefined>;
}

/** What the scheduler's operations outside `scheduler.ts` work with. */
export interface SchedulerDeps {
  store: Store;
  clock: Clock;
  log: Logger;
  checks: Checks;
  retry: RetryPolicy;
  staleMs: number;
}
