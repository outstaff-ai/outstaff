import type { ModelCounts } from "#/store/types.js";

const COUNTS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;

/** A report below the previous one in any count: the session's total started over (for example after a clear). */
const startedOver = (now: ModelCounts, was: ModelCounts) =>
  COUNTS.some((k) => now[k] < was[k]) || (now.costUsd ?? 0) < (was.costUsd ?? 0);

/** What a session's new running total for a model adds to its previous one. */
export function usageDelta(now: ModelCounts, was: ModelCounts | undefined): ModelCounts {
  if (!was || startedOver(now, was)) {
    return now;
  }

  return {
    model: now.model,
    inputTokens: now.inputTokens - was.inputTokens,
    outputTokens: now.outputTokens - was.outputTokens,
    cacheReadTokens: now.cacheReadTokens - was.cacheReadTokens,
    cacheCreationTokens: now.cacheCreationTokens - was.cacheCreationTokens,
    costUsd: now.costUsd === null ? null : now.costUsd - (was.costUsd ?? 0),
  };
}

/** Two usages of one model added up; an unknown cost stays unknown only when both are. */
export function addCounts(a: ModelCounts, b: ModelCounts): ModelCounts {
  return {
    model: a.model,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

/** Whether the usage counts nothing at all. */
export const isEmpty = (u: ModelCounts) =>
  COUNTS.every((k) => u[k] === 0) && (u.costUsd ?? 0) === 0;
