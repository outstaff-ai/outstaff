import { silentLogger } from "@outstaff/core";
import type { WorkItem } from "#/store/types.js";
import type { Cancel } from "#/types.js";
import type { SchedulerDeps } from "./checks.types.js";
import { createChecks, personScope, TEAM_SCOPE } from "./checks.js";
import { enqueueItem, releaseHold } from "./enqueue.js";
import { blockById, failItem, finishItem, interruptItem, retryItem } from "./outcomes.js";
import { CHAT_KIND, DEFAULT_RETRY, isLoopGuarded, orderQueue } from "./policy.js";
import { runTick } from "./tick.js";
import type { PauseState, Scheduler, SchedulerOptions, StartResult } from "./types.js";

/** Chat sessions run beside the active work item, up to `policies.chat.parallel_sessions`. */
const DEFAULT_CHAT_SESSIONS = 2;

// Mirrors the team.yaml defaults for a team that sets no `policies`.
const DEFAULT_MAX_RUNS_PER_HOUR = 12;

/** The team's limits, with the team.yaml defaults where it sets none. */
function limitsOf(team: SchedulerOptions["team"]) {
  return {
    maxRuns:
      team.policies?.agent_loop_guard.max_runs_per_item_per_hour ?? DEFAULT_MAX_RUNS_PER_HOUR,
    chatSessions: team.policies?.chat?.parallel_sessions ?? DEFAULT_CHAT_SESSIONS,
    retry: { ...DEFAULT_RETRY, ...team.policies?.retry },
  };
}

/** Why a queued item is not offered yet: the backoff after a failure, or the hold that lets close wakes fold in. */
const heldUntil = (item: WorkItem) =>
  item.failures > 0
    ? `Held back after a failed run until ${item.notBefore}.`
    : `Held until ${item.notBefore}, so wakes that come close together run as one.`;

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const { store, team, clock } = opts;
  const log = opts.logger ?? silentLogger;

  const staleMs = (opts.staleAfterMinutes ?? 10) * 60_000;
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
  });

  const {
    hasRoom,
    mergeRunning,
    backingOff,
    getWindows,
    pauseBlock,
    usageBlock,
    guardTripped,
    blockItem,
    queuedOf,
    applyMove,
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

  /** Why the person has no room for the item: a full lane, or another merge running in the repository. */
  const busyDetail = async (item: WorkItem): Promise<string> => {
    if (item.kind === CHAT_KIND) {
      return `${item.person} already runs ${chatSessions} chat sessions.`;
    }

    const own = await store.listItems({ person: item.person, status: "active" });
    const merging = own.some((i) => i.kind !== CHAT_KIND) ? undefined : await mergeRunning(item);
    return merging
      ? `${merging.person} is merging in the same repository (${merging.subject!.ref}); one merge runs per repository at a time.`
      : `${item.person} already has an active item.`;
  };

  /** Why the item cannot start now: it is not queued, its person has no room, or it backs off after a failure. */
  const notReady = async (item: WorkItem): Promise<StartResult | undefined> => {
    if (item.status !== "queued") {
      return { started: false, reason: "not_queued", detail: `Item is ${item.status}.` };
    }

    if (!(await hasRoom(item))) {
      return { started: false, reason: "busy", detail: await busyDetail(item) };
    }

    return backingOff(item)
      ? { started: false, reason: "backoff", detail: heldUntil(item) }
      : undefined;
  };

  /** Why the item is held back: a pause, too little usage left, or the loop guard, which blocks it. */
  const heldBack = async (item: WorkItem): Promise<StartResult | undefined> => {
    const held = (await pauseBlock(item.person)) ?? (await usageBlock(item.person, item));
    if (held) {
      return { started: false, reason: held.code, detail: held.reason };
    }

    const tripped = await guardTripped(item);
    if (!tripped) {
      return undefined;
    }

    const blocked = await blockItem(item, tripped, "loop_guard");
    return { started: false, reason: "loop_guard", detail: tripped, blocked };
  };

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
        if (!(await hasRoom(item))) {
          continue;
        }

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

        const refused = (await notReady(item)) ?? (await heldBack(item));
        if (refused) {
          return refused;
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
