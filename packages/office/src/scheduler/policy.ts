import type { WorkItem, WorkItemTrigger } from "#/store/types.js";
import type {
  LoopGuardVerdict,
  MoveTarget,
  QueuePlacement,
  RetryPolicy,
  RunBlock,
  StaleVerdict,
  UsageThresholds,
  UsageWindow,
} from "./policy.types.js";

// Pure scheduling policy. Nothing here touches the store or the clock.

export const PRIORITY = {
  humanChat: 0,
  human: 10,
  agent: 50,
  automation: 60,
  schedule: 80,
} as const;

export const CHAT_KIND = "chat";
export const HOUR_MS = 60 * 60 * 1000;

/** Priority class of new work: by trigger, and human chat ahead of other human work. */
export function priorityFor(trigger: WorkItemTrigger, kind: string): number {
  switch (trigger) {
    case "human":
      return kind === CHAT_KIND ? PRIORITY.humanChat : PRIORITY.human;
    case "agent":
      return PRIORITY.agent;
    case "automation":
      return PRIORITY.automation;
    case "schedule":
      return PRIORITY.schedule;
  }
}

type Orderable = Pick<WorkItem, "id" | "priority" | "position" | "createdAt">;

/** Lower priority number first; within a class explicit position, then age, then id. */
export function compareQueue(a: Orderable, b: Orderable): number {
  return (
    a.priority - b.priority ||
    a.position - b.position ||
    (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function orderQueue<T extends Orderable>(items: readonly T[]): T[] {
  return items.toSorted(compareQueue);
}

/** Where the moved item goes among the other queued items. */
function moveIndex(rest: readonly Orderable[], itemId: string, target: MoveTarget): number {
  if ("last" in target) {
    return rest.length;
  }

  const anchorId = "before" in target ? target.before : target.after;
  if (anchorId === itemId) {
    throw new Error("cannot move a work item relative to itself");
  }

  const at = rest.findIndex((i) => i.id === anchorId);
  if (at < 0) {
    throw new Error(`work item ${anchorId} is not in the same queue`);
  }

  return "before" in target ? at : at + 1;
}

/** The moved item's priority class, kept between the classes of its new neighbours. */
function clampPriority(priority: number, prev?: Orderable, next?: Orderable): number {
  const atLeast = prev ? Math.max(priority, prev.priority) : priority;
  return next ? Math.min(atLeast, next.priority) : atLeast;
}

/**
 * Plans an explicit move inside one person's queued items. Returns the new
 * priority and position of every item, renumbered 1..n in the new order.
 * The moved item keeps its priority class unless that would keep it on the
 * wrong side of its new neighbours; then it takes the nearest class.
 */
export function planMove(
  queue: readonly Orderable[],
  itemId: string,
  target: MoveTarget,
): QueuePlacement[] {
  const ordered = orderQueue(queue);
  const moved = ordered.find((i) => i.id === itemId);
  if (!moved) {
    throw new Error(`work item ${itemId} is not queued`);
  }

  const rest = ordered.filter((i) => i.id !== itemId);
  const index = moveIndex(rest, itemId, target);
  const priority = clampPriority(moved.priority, rest[index - 1], rest[index]);
  const result = [...rest.slice(0, index), { ...moved, priority }, ...rest.slice(index)];
  return result.map((i, n) => ({ id: i.id, priority: i.priority, position: n + 1 }));
}

/** Only agent- and automation-triggered runs are limited; humans never are. */
export function isLoopGuarded(trigger: WorkItemTrigger): boolean {
  return trigger === "agent" || trigger === "automation";
}

export function loopGuardVerdict(
  trigger: WorkItemTrigger,
  runsInWindow: number,
  maxRunsPerHour: number,
): LoopGuardVerdict {
  if (!isLoopGuarded(trigger) || runsInWindow < maxRunsPerHour) {
    return { tripped: false };
  }

  return {
    tripped: true,
    reason: `Loop guard: ${runsInWindow} ${trigger}-triggered runs in the last hour (limit ${maxRunsPerHour}). Blocked until a human unblocks it.`,
  };
}

export function peakWindow<T extends UsageWindow>(windows: readonly T[]): T | undefined {
  let peak: T | undefined;
  for (const w of windows) {
    if (!peak || w.utilization > peak.utilization) {
      peak = w;
    }
  }

  return peak;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Humans are always answered. Above `pause_automatic_at` only human-triggered
 * work runs; above `defer_scheduled_at` scheduled work waits.
 */
export function usageVerdict(
  trigger: WorkItemTrigger,
  windows: readonly UsageWindow[],
  thresholds: UsageThresholds,
): RunBlock | null {
  const peak = peakWindow(windows);
  if (trigger === "human" || !peak) {
    return null;
  }

  if (peak.utilization >= thresholds.pause_automatic_at) {
    return {
      code: "usage_pause",
      reason: `Usage ${pct(peak.utilization)} of the ${peak.name} limit (pause threshold ${pct(thresholds.pause_automatic_at)}): only human-triggered work runs.`,
    };
  }

  if (trigger === "schedule" && peak.utilization >= thresholds.defer_scheduled_at) {
    return {
      code: "usage_defer",
      reason: `Usage ${pct(peak.utilization)} of the ${peak.name} limit (defer threshold ${pct(thresholds.defer_scheduled_at)}): scheduled work waits.`,
    };
  }

  return null;
}

/**
 * An active item with no heartbeat for `staleMs` is retried once; if its last
 * run already ended stale (`trailingStaleRuns` > 0) it is blocked instead.
 */
export function staleVerdict(input: {
  lastActivity: Date;
  now: Date;
  staleMs: number;
  trailingStaleRuns: number;
}): StaleVerdict {
  if (input.now.getTime() - input.lastActivity.getTime() < input.staleMs) {
    return "ok";
  }

  return input.trailingStaleRuns > 0 ? "block" : "retry";
}

/** Number of consecutive stale runs at the end of an item's run history (oldest first). */
export function trailingStale(outcomes: readonly (string | null)[]): number {
  let n = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i] !== "stale") {
      // The currently open run has no outcome yet and does not break the streak.
      if (outcomes[i] === null && i === outcomes.length - 1) {
        continue;
      }

      break;
    }

    n++;
  }

  return n;
}

export const DEFAULT_RETRY: RetryPolicy = { base_minutes: 1, cap_minutes: 30, max_failures: 3 };

/** Wait after the n-th consecutive failure (n >= 1): base * 2^(n-1), at most the cap. */
export function backoffMs(
  failures: number,
  retry: Pick<RetryPolicy, "base_minutes" | "cap_minutes">,
) {
  const minutes = Math.min(retry.base_minutes * 2 ** Math.max(0, failures - 1), retry.cap_minutes);
  return minutes * 60_000;
}
