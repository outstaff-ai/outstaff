import { silentLogger } from "@outstaff/core";
import type { WorkItem } from "#/store/types.js";
import type { Cancel } from "#/types.js";
import type { SchedulerDeps } from "./checks.types.js";
import { createChecks, personScope, TEAM_SCOPE } from "./checks.js";
import { enqueueItem, releaseHold } from "./enqueue.js";
import {
  abandonItem,
  blockById,
  failItem,
  finishItem,
  interruptItem,
  retryItem,
} from "./outcomes.js";
import { DEFAULT_RETRY, orderQueue } from "./policy.js";
import { offerItem, startItemRun } from "./start.js";
import type { UsageWindow } from "./policy.types.js";
import { runTick } from "./tick.js";
import type { PauseState, Scheduler, SchedulerOptions } from "./types.js";

/** Chat sessions run beside the active work item, up to `policies.chat.parallel_sessions`. */
const DEFAULT_CHAT_SESSIONS = 2;

// Mirrors `scheduler.stale_run_after_minutes`.
const DEFAULT_STALE_AFTER_MINUTES = 5;

// Mirrors the team.yaml defaults for a team that sets no `policies`.
const DEFAULT_MAX_RUNS_PER_HOUR = 12;

/** The team's limits, with the team.yaml defaults where it sets none. */
function limitsOf(team: SchedulerOptions["team"]) {
  return {
    maxRuns:
      team.policies?.agent_loop_guard.max_runs_per_subject_per_hour ?? DEFAULT_MAX_RUNS_PER_HOUR,
    chatSessions: team.policies?.chat?.parallel_sessions ?? DEFAULT_CHAT_SESSIONS,
    retry: { ...DEFAULT_RETRY, ...team.policies?.retry },
  };
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const { store, team, clock } = opts;
  const log = opts.logger ?? silentLogger;

  const staleAfter =
    opts.staleAfterMinutes ??
    team.scheduler?.stale_run_after_minutes ??
    DEFAULT_STALE_AFTER_MINUTES;

  const staleMs = staleAfter * 60_000;
  const tickIntervalMs = opts.tickIntervalMs ?? 60_000;
  const { maxRuns, chatSessions, retry } = limitsOf(team);

  // Serializes mutations inside this process; durable state is all in the store.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const checks = createChecks({
    store,
    team,
    clock,
    log,
    usage: opts.usage,
    maxRuns,
    chatSessions,
    stopped: opts.stopped,
  });

  const {
    hasRoom,
    backingOff,
    getWindows,
    pauseBlock,
    usageBlock,
    guardTripped,
    queuedOf,
    applyMove,
    stop,
  } = checks;

  const deps: SchedulerDeps = { store, clock, log, checks, retry, staleMs };

  // An item held for coalescing is released when its window closes; the tick releases it too, after a restart.
  const holds = new Set<Cancel>();
  const held = (item: WorkItem) => {
    const cancel = clock.setTimeout(
      () => {
        holds.delete(cancel);
        exclusive(() => releaseHold(deps, item, opts.onReleased)).catch((err: unknown) =>
          log.warn("could not release a held work item", { item: item.id, error: String(err) }),
        );
      },
      Date.parse(item.notBefore!) - clock.now().getTime(),
    );

    holds.add(cancel);
  };

  /** Whether a queued item waits for now: a failure backoff, too little usage left, or the loop guard. */
  const waits = async (item: WorkItem, windows: UsageWindow[]) =>
    backingOff(item) ||
    (await usageBlock(item.person, item, windows)) !== null ||
    (await guardTripped(item)) !== null;

  const scheduler: Scheduler = {
    enqueue(input) {
      return exclusive(() => enqueueItem(deps, input, held));
    },

    async next(person) {
      if (await pauseBlock(person)) {
        return null;
      }

      const queue = orderQueue(await queuedOf(person));
      if (queue.length === 0) {
        return null;
      }

      const windows = await getWindows(person);
      for (const item of queue) {
        if (!(await hasRoom(item)) || (await exclusive(() => stop(item)))) {
          continue;
        }

        if (!(await waits(item, windows))) {
          return item;
        }
      }

      return null;
    },

    offer(itemId) {
      return exclusive(() => offerItem(deps, itemId));
    },

    startRun(itemId) {
      return exclusive(() => startItemRun(deps, itemId));
    },

    markActive(itemId) {
      return exclusive(async () => {
        const offered = await offerItem(deps, itemId);
        return offered.started ? { ...offered, run: await store.startRun(itemId) } : offered;
      });
    },

    abandon(itemId, reason) {
      return exclusive(() => abandonItem(deps, itemId, reason));
    },

    async heartbeat(itemId) {
      await store.updateItem(itemId, {});
    },

    finish(itemId, input) {
      return exclusive(() => finishItem(deps, itemId, input));
    },

    interrupt(itemId, outcome) {
      return exclusive(() => interruptItem(deps, itemId, outcome));
    },

    fail(itemId, error) {
      return exclusive(() => failItem(deps, itemId, error));
    },

    block(itemId, reason) {
      return exclusive(() => blockById(deps, itemId, reason));
    },

    retry(itemId, request) {
      return exclusive(() => retryItem(deps, itemId, request));
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
      return exclusive(() => runTick(deps));
    },

    start(onTick) {
      stopTick();
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
      stopTick();
      for (const cancel of holds) {
        cancel();
      }

      holds.clear();
    },
  };

  let running = false;
  let stopTimer: (() => void) | undefined;
  const stopTick = () => {
    running = false;
    stopTimer?.();
    stopTimer = undefined;
  };

  return scheduler;
}
