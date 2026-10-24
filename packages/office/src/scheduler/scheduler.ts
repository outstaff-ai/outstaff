import { silentLogger, type Logger, type TeamConfig } from "@outstaff/core";
import type { Clock } from "../clock.js";
import type { NewWorkItem, Run, Store, WorkItem } from "../store/types.js";
import {
  CHAT_KIND,
  DEFAULT_RETRY,
  HOUR_MS,
  backoffMs,
  isLoopGuarded,
  loopGuardVerdict,
  orderQueue,
  planMove,
  priorityFor,
  staleVerdict,
  trailingStale,
  usageVerdict,
  type MoveTarget,
  type RunBlock,
  type UsageWindow,
} from "./policy.js";

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
}

export type Placement = "next" | "last" | { before: string } | { after: string };

export interface EnqueueInput extends Omit<NewWorkItem, "position"> {
  /**
   * Where the item goes among the person's queued items. Default: the priority
   * class decides, except that human chat waits last until the human chooses a
   * position. An idle person starts either way.
   */
  placement?: Placement;
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
   * The item the person should run next, or null: while one is active, while
   * paused, and when every queued item is held back by a policy or by a failure backoff. Does not change state.
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

const isChat = (i: Pick<NewWorkItem, "trigger" | "kind">) =>
  i.trigger === "human" && i.kind === CHAT_KIND;

// Mirrors the team.yaml defaults for a team that sets no `policies`.
const DEFAULT_MAX_RUNS_PER_HOUR = 12;
const DEFAULT_USAGE = { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 };

const TEAM_SCOPE = "team";
const personScope = (person: string) => `person:${person}`;

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const { store, team, clock } = opts;
  const log = opts.logger ?? silentLogger;

  const staleMs = (opts.staleAfterMinutes ?? 10) * 60_000;
  const tickIntervalMs = opts.tickIntervalMs ?? 60_000;
  const maxRuns =
    team.policies?.agent_loop_guard.max_runs_per_item_per_hour ?? DEFAULT_MAX_RUNS_PER_HOUR;

  // Serializes mutations inside this process; durable state is all in the store.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const retry = { ...DEFAULT_RETRY, ...team.policies?.retry };

  const backingOff = (item: Pick<WorkItem, "notBefore">) =>
    item.notBefore !== null && Date.parse(item.notBefore) > clock.now().getTime();

  const getWindows = async (person: string): Promise<UsageWindow[]> => {
    if (!opts.usage) {
      return [];
    }

    try {
      return await opts.usage.windows(person);
    } catch (err) {
      // Fail open: a broken usage feed must not stop humans from being answered.
      log.warn("usage source failed; ignoring usage policy", { person, error: String(err) });
      return [];
    }
  };

  const pauseBlock = async (person: string): Promise<RunBlock | null> => {
    const pauses = await store.listPauses();
    const t = pauses.find((p) => p.scope === TEAM_SCOPE);
    if (t) {
      return { code: "paused_team", reason: `Team paused${t.reason ? `: ${t.reason}` : ""}.` };
    }

    const p = pauses.find((x) => x.scope === personScope(person));
    if (p) {
      return {
        code: "paused_person",
        reason: `${person} paused${p.reason ? `: ${p.reason}` : ""}.`,
      };
    }

    return null;
  };

  const usageBlock = async (
    person: string,
    item: Pick<WorkItem, "trigger">,
    windows?: UsageWindow[],
  ): Promise<RunBlock | null> => {
    if (item.trigger === "human") {
      return null;
    }

    return usageVerdict(
      item.trigger,
      windows ?? (await getWindows(person)),
      team.policies?.usage ?? DEFAULT_USAGE,
    );
  };

  const guardTripped = async (item: WorkItem): Promise<string | null> => {
    if (!isLoopGuarded(item.trigger)) {
      return null;
    }

    const count = await store.countLoopGuard(item.id, HOUR_MS);
    const v = loopGuardVerdict(item.trigger, count, maxRuns);
    return v.tripped ? (v.reason ?? "Loop guard tripped.") : null;
  };

  const openRun = async (itemId: string): Promise<Run | undefined> => {
    const runs = await store.listRuns(itemId);
    return runs.findLast((r) => r.finishedAt === null);
  };

  const blockItem = async (
    item: WorkItem,
    reason: string,
    code: BlockNotice["code"],
  ): Promise<BlockNotice> => {
    const run = await openRun(item.id);
    if (run) {
      await store.finishRun(run.id, { outcome: "blocked", error: reason });
    }

    const updated = await store.updateItem(item.id, { status: "blocked" });
    await store.appendJournal(item.id, "scheduler", `Blocked: ${reason}`);
    log.warn("work item blocked", { item: item.id, person: item.person, code, reason });
    return { item: updated, reason, code };
  };

  const queuedOf = (person: string) => store.listItems({ person, status: "queued" });

  const applyMove = async (itemId: string, target: MoveTarget): Promise<void> => {
    const item = await store.getItem(itemId);
    if (!item) {
      throw new Error(`unknown work item: ${itemId}`);
    }

    if (item.status !== "queued") {
      throw new Error(`work item ${itemId} is ${item.status}; only queued items can be moved`);
    }

    const queue = await queuedOf(item.person);
    await store.reorderQueue(planMove(queue, itemId, target));
  };

  const scheduler: Scheduler = {
    enqueue(input) {
      return exclusive(async () => {
        const { placement: chosen, ...rest } = input;
        const placement = chosen ?? (isChat(input) ? "last" : undefined);
        const created = await store.enqueue({
          ...rest,
          priority: input.priority ?? priorityFor(input.trigger, input.kind),
        });

        if (placement !== undefined) {
          const queue = await queuedOf(created.person);
          const first = orderQueue(queue).find((i) => i.id !== created.id);
          if (placement === "next") {
            if (first) {
              await applyMove(created.id, { before: first.id });
            }
          } else if (placement === "last") {
            await applyMove(created.id, { last: true });
          } else {
            await applyMove(created.id, placement);
          }
        }

        return (await store.getItem(created.id)) ?? created;
      });
    },

    async next(person) {
      if (await pauseBlock(person)) {
        return null;
      }

      if ((await store.listItems({ person, status: "active" })).length > 0) {
        return null;
      }

      const queue = orderQueue(await queuedOf(person));
      if (queue.length === 0) {
        return null;
      }

      const windows = await getWindows(person);
      for (const item of queue) {
        if (backingOff(item)) {
          continue;
        }

        if (await usageBlock(person, item, windows)) {
          continue;
        }

        if (await guardTripped(item)) {
          continue;
        }

        return item;
      }

      return null;
    },

    markActive(itemId) {
      return exclusive(async (): Promise<StartResult> => {
        const item = await store.getItem(itemId);
        if (!item) {
          throw new Error(`unknown work item: ${itemId}`);
        }

        if (item.status !== "queued") {
          return { started: false, reason: "not_queued", detail: `Item is ${item.status}.` };
        }

        if ((await store.listItems({ person: item.person, status: "active" })).length > 0) {
          return {
            started: false,
            reason: "busy",
            detail: `${item.person} already has an active item.`,
          };
        }

        if (backingOff(item)) {
          return {
            started: false,
            reason: "backoff",
            detail: `Held back after a failed run until ${item.notBefore}.`,
          };
        }

        const held = (await pauseBlock(item.person)) ?? (await usageBlock(item.person, item));
        if (held) {
          return { started: false, reason: held.code, detail: held.reason };
        }

        const tripped = await guardTripped(item);
        if (tripped) {
          const blocked = await blockItem(item, tripped, "loop_guard");
          return { started: false, reason: "loop_guard", detail: tripped, blocked };
        }

        const active = await store.activateItem(itemId);
        if (!active) {
          return { started: false, reason: "not_queued", detail: "Item is no longer queued." };
        }

        if (isLoopGuarded(active.trigger)) {
          await store.recordLoopGuard(active.id);
        }

        const run = await store.startRun(active.id);
        return { started: true, item: active, run };
      });
    },

    async heartbeat(itemId) {
      await store.updateItem(itemId, {});
    },

    finish(itemId, input) {
      return exclusive(async () => {
        const run = await openRun(itemId);
        if (run) {
          await store.finishRun(run.id, {
            outcome: input.outcome,
            ...(input.error === undefined ? {} : { error: input.error }),
            ...(input.usage === undefined ? {} : { usage: input.usage }),
          });
        }

        const status = input.status ?? "done";
        // Finishing the work is a success; a plain requeue is not.
        return store.updateItem(itemId, {
          status,
          ...(status === "queued" ? {} : { failures: 0, notBefore: null }),
        });
      });
    },

    fail(itemId, error) {
      return exclusive(async () => {
        const item = await store.getItem(itemId);
        if (!item) {
          throw new Error(`unknown work item: ${itemId}`);
        }

        const run = await openRun(itemId);
        if (run) {
          await store.finishRun(run.id, { outcome: "failed", error });
        }

        const failures = item.failures + 1;
        if (failures >= retry.max_failures) {
          const firstLine = error.split("\n", 1)[0]?.trim() || "unknown error";
          const blocked = await blockItem(
            item,
            `failed ${failures} times: ${firstLine}`,
            "failures",
          );

          // A human who unblocks the item starts it with a clean count.
          const reset = await store.updateItem(itemId, { failures: 0, notBefore: null });
          return { item: reset, blocked: { ...blocked, item: reset } };
        }

        const notBefore = new Date(
          clock.now().getTime() + backoffMs(failures, retry),
        ).toISOString();

        const updated = await store.updateItem(itemId, { status: "queued", failures, notBefore });
        await store.appendJournal(
          itemId,
          "scheduler",
          `Failed ${failures} of ${retry.max_failures} times; retrying after ${notBefore}.`,
        );

        log.warn("work item failed; backing off", { item: itemId, failures, notBefore });
        return { item: updated, notBefore };
      });
    },

    block(itemId, reason) {
      return exclusive(async () => {
        const item = await store.getItem(itemId);
        if (!item) {
          throw new Error(`unknown work item: ${itemId}`);
        }

        return blockItem(item, reason, "manual");
      });
    },

    retry(itemId, request) {
      return exclusive(async () => {
        const item = await store.getItem(itemId);
        if (item?.status !== "blocked") {
          return null;
        }

        await store.clearLoopGuard(itemId);
        const queued = await store.updateItem(itemId, {
          status: "queued",
          failures: 0,
          notBefore: null,
        });

        await store.appendJournal(
          itemId,
          "scheduler",
          `Retried on request by ${request.by} (${request.signal}).`,
        );

        log.info(
          `retried ${itemId} for ${request.by} on ${item.subject?.ref ?? item.title} (signal: ${request.signal})`,
          { item: itemId, person: item.person, by: request.by, signal: request.signal },
        );

        return queued;
      });
    },

    move(itemId, target) {
      return exclusive(() => applyMove(itemId, target));
    },

    pause: (person, reason) => store.setPause(person ? personScope(person) : TEAM_SCOPE, reason),

    async resume(person) {
      await store.clearPause(person ? personScope(person) : TEAM_SCOPE);
    },

    async pauseState() {
      const state: PauseState = { team: null, people: {} };
      for (const p of await store.listPauses()) {
        const entry = { reason: p.reason, since: p.pausedAt };
        if (p.scope === TEAM_SCOPE) {
          state.team = entry;
        } else if (p.scope.startsWith("person:")) {
          state.people[p.scope.slice("person:".length)] = entry;
        }
      }

      return state;
    },

    async isPausedFor(person, item) {
      return (await pauseBlock(person)) ?? (await usageBlock(person, item));
    },

    tick() {
      return exclusive(async () => {
        const result: TickResult = { retried: [], released: [], blocked: [] };
        const now = clock.now();

        for (const item of await store.listItems({ status: "active" })) {
          const runs = await store.listRuns(item.id);
          const verdict = staleVerdict({
            lastActivity: new Date(item.updatedAt),
            now,
            staleMs,
            trailingStaleRuns: trailingStale(runs.map((r) => r.outcome)),
          });

          if (verdict === "ok") {
            continue;
          }

          const minutes = Math.round(staleMs / 60_000);
          const run = runs.findLast((r) => r.finishedAt === null);
          if (verdict === "retry") {
            if (run) {
              await store.finishRun(run.id, {
                outcome: "stale",
                error: `No heartbeat for ${minutes} minutes.`,
              });
            }

            const requeued = await store.updateItem(item.id, { status: "queued" });
            await store.appendJournal(item.id, "scheduler", "Run went stale; retrying once.");
            log.warn("stale run requeued", { item: item.id });
            result.retried.push(requeued);
          } else {
            result.blocked.push(
              await blockItem(
                item,
                `Stale again: no heartbeat for ${minutes} minutes on the retry.`,
                "stale",
              ),
            );
          }
        }

        // Backoff that ran out: clear it so the person is told there is work again.
        for (const item of await store.listItems({ status: "queued" })) {
          if (item.notBefore !== null && !backingOff(item)) {
            result.released.push(await store.updateItem(item.id, { notBefore: null }));
          }
        }

        // Surface loop-guard trips even when nobody asks for the item.
        const people = new Set((await store.listItems({ status: "queued" })).map((i) => i.person));
        for (const person of people) {
          for (const item of await queuedOf(person)) {
            const tripped = await guardTripped(item);
            if (tripped) {
              result.blocked.push(await blockItem(item, tripped, "loop_guard"));
            }
          }
        }

        return result;
      });
    },

    start(onTick) {
      scheduler.stop();
      stopTimer = undefined;
      const loop = () => {
        scheduler
          .tick()
          .then((r) => onTick?.(r))
          .catch((err: unknown) => log.error("scheduler tick failed", { error: String(err) }))
          .finally(() => {
            if (running) {
              stopTimer = clock.setTimeout(loop, tickIntervalMs);
            }
          });
      };

      running = true;
      stopTimer = clock.setTimeout(loop, tickIntervalMs);
    },

    stop() {
      running = false;
      stopTimer?.();
      stopTimer = undefined;
    },
  };

  let running = false;
  let stopTimer: (() => void) | undefined;
  return scheduler;
}
