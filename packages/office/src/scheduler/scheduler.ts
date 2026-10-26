import { silentLogger } from "@outstaff/core";
import type { SchedulerDeps } from "./checks.types.js";
import { createChecks, personScope, TEAM_SCOPE } from "./checks.js";
import { blockById, failItem, finishItem, interruptItem, retryItem } from "./outcomes.js";
import { CHAT_KIND, DEFAULT_RETRY, isLoopGuarded, orderQueue, priorityFor } from "./policy.js";
import { runTick } from "./tick.js";
import type { PauseState, Scheduler, SchedulerOptions, StartResult } from "./types.js";

/** Chat sessions run beside the active work item, up to `policies.chat.parallel_sessions`. */
const DEFAULT_CHAT_SESSIONS = 2;

// Mirrors the team.yaml defaults for a team that sets no `policies`.
const DEFAULT_MAX_RUNS_PER_HOUR = 12;

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
  const chatSessions = team.policies?.chat?.parallel_sessions ?? DEFAULT_CHAT_SESSIONS;
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

  const scheduler: Scheduler = {
    enqueue(input) {
      return exclusive(async () => {
        const { placement: chosen, init, ...rest } = input;
        const placement = chosen;
        const created = await store.enqueue({
          ...rest,
          priority: input.priority ?? priorityFor(input.trigger, input.kind),
        });

        await init?.(created);

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

        if (item.status !== "queued") {
          return { started: false, reason: "not_queued", detail: `Item is ${item.status}.` };
        }

        if (!(await hasRoom(item))) {
          return {
            started: false,
            reason: "busy",
            detail:
              item.kind === CHAT_KIND
                ? `${item.person} already runs ${chatSessions} chat sessions.`
                : `${item.person} already has an active item.`,
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
