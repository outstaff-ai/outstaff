import type { Logger, TeamConfig } from "@outstaff/core";
import type { NewWorkItem, Run, Store, WorkItem } from "#/store/types.js";
import type { Clock } from "#/types.js";
import type { MoveTarget, RunBlock, UsageWindow } from "./policy.types.js";

export interface UsageSource {
  /** Current 5h / 7d utilization for the runtime account the person uses. */
  windows(person: string): Promise<UsageWindow[]>;
}

export interface SchedulerOptions {
  store: Store;
  team: Pick<TeamConfig, "policies">;
  clock: Clock;
  logger?: Logger;
  usage?: UsageSource;

  /** Minutes without a heartbeat before an active item is stale. Default 10. */
  staleAfterMinutes?: number;

  /** Interval of the background tick started by `start()`. Default 60 seconds. */
  tickIntervalMs?: number;

  /** A queued item held for coalescing can be offered now; the person is told there is work. */
  onReleased?: (person: string) => void;
}

export type Placement = "next" | "last" | { before: string } | { after: string };

/**
 * Wakes that come close together become one run: the item queued for the first is held until its window closes, and
 * a later wake with the same key inside the window is folded into it instead of queuing another.
 */
export interface Coalesce {
  /** What makes two wakes the same run: the person and the subject. */
  key: string;

  /** When the event behind the wake happened (ISO-8601). The window counts from the first one's. */
  at: string;

  /** How long the window stays open; 0 folds and holds nothing. */
  windowMs: number;

  /** Adds this wake to the held item an earlier one queued. */
  fold(item: WorkItem): Promise<void>;
}

export interface EnqueueInput extends Omit<NewWorkItem, "position"> {
  /**
   * Where the item goes among the person's queued items. Default: the priority
   * class decides.
   */
  placement?: Placement;

  /**
   * Runs once the item exists and before anything can start it, so an offer never goes out without what this
   * stores for the item (its chat origin, its feedback).
   */
  init?: (item: WorkItem) => Promise<void>;

  /** Folds the item into a held one with the same key, or holds it for the ones that follow. */
  coalesce?: Coalesce;
}

export type StartResult =
  | { started: true; item: WorkItem; run: Run }
  | {
      started: false;
      reason: "not_queued" | "busy" | "backoff" | RunBlock["code"] | "loop_guard";
      detail: string;

      /** Set when the attempt blocked the item (loop guard). */
      blocked?: BlockNotice;
    };

export interface BlockNotice {
  item: WorkItem;
  reason: string;
  code: "loop_guard" | "stale" | "failures" | "manual";
}

export interface TickResult {
  /** Stale items sent back to the queue for their one retry. */
  retried: WorkItem[];

  /** Failed items whose backoff ran out; they can be offered again. */
  released: WorkItem[];

  /** Items the tick blocked: stale twice, or tripped by the loop guard. */
  blocked: BlockNotice[];
}

export interface FinishInput {
  outcome: string;

  /** What the item becomes. Default "done". */
  status?: "done" | "waiting" | "queued" | "canceled";
  error?: string;
  usage?: unknown;
}

export interface FailResult {
  item: WorkItem;

  /** Set when this failure was the last one allowed and blocked the item. */
  blocked?: BlockNotice;

  /** When a queued item may run again. */
  notBefore?: string;
}

export interface RetryRequest {
  /** The human who asked. */
  by: string;

  /** What they did, for the journal and the log: "ticket moved", "PR comment", "chat reply". */
  signal: string;
}

export interface PauseState {
  team: { reason: string | null; since: string } | null;
  people: Record<string, { reason: string | null; since: string }>;
}

export interface Scheduler {
  enqueue(input: EnqueueInput): Promise<WorkItem>;

  /**
   * The item the person should run next, or null: while paused, and when every queued item is held back by a
   * policy, a failure backoff, or a lane that is full (one work item at a time; chat sessions up to
   * `policies.chat.parallel_sessions`, beside it). Does not change state.
   */
  next(person: string): Promise<WorkItem | null>;

  /** Starts a run of a queued item (re-checks every policy). */
  markActive(itemId: string): Promise<StartResult>;

  /** Records activity so the item is not considered stale. */
  heartbeat(itemId: string): Promise<void>;
  finish(itemId: string, input: FinishInput): Promise<WorkItem>;

  /**
   * Ends the run as failed. The item goes back to the queue but is held back with exponential backoff; after
   * `policies.retry.max_failures` failures in a row it is blocked instead.
   */
  fail(itemId: string, error: string): Promise<FailResult>;

  /**
   * Ends the run because the agent shut down. The item goes back to the front of the person's queue with its
   * session and workspace. The run is no failure and no loop: it counts for neither the retry nor the loop guard.
   */
  interrupt(itemId: string, outcome: string): Promise<WorkItem>;

  /** Blocks the item and journals the reason. */
  block(itemId: string, reason: string): Promise<BlockNotice>;

  /**
   * A trusted human asked for a blocked item to run again: it is queued with no failures, no backoff and no
   * loop-guard count; its session and journal stay. Returns null when the item is not blocked (nothing to retry).
   */
  retry(itemId: string, request: RetryRequest): Promise<WorkItem | null>;

  /** Explicit reorder of a queued item. Active items are never interrupted. */
  move(itemId: string, target: MoveTarget): Promise<void>;

  /** Pauses starting new work for one person, or the whole team. Running items are not interrupted. */
  pause(person?: string, reason?: string): Promise<void>;
  resume(person?: string): Promise<void>;
  pauseState(): Promise<PauseState>;

  /** Why the item cannot run now, or null. Humans always get null from usage limits. */
  isPausedFor(person: string, item: Pick<WorkItem, "trigger">): Promise<RunBlock | null>;

  /** Housekeeping: stale runs and loop-guard sweep. Call periodically. */
  tick(): Promise<TickResult>;

  /** Runs `tick` on the clock until `stop()`. Results go to `onTick`. */
  start(onTick?: (result: TickResult) => void): void;
  stop(): void;
}
