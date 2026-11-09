import type { UsageTotals } from "@outstaff/protocol";
import type { ModelCounts, RunUsageRow } from "#/store/types.js";

export const NO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  tokens: 0,
  costUsd: 0,
  runs: 0,
};

/** The rows added up; `runs` counts the distinct runs among them. */
export function totalsOf(rows: readonly (ModelCounts & Pick<RunUsageRow, "runId">)[]): UsageTotals {
  const sum = (pick: (r: ModelCounts) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const inputTokens = sum((r) => r.inputTokens);
  const outputTokens = sum((r) => r.outputTokens);
  const cacheReadTokens = sum((r) => r.cacheReadTokens);
  const cacheCreationTokens = sum((r) => r.cacheCreationTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    tokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    costUsd: sum((r) => r.costUsd ?? 0),
    runs: new Set(rows.map((r) => r.runId)).size,
  };
}

/** Two totals added up; their runs are distinct, as a ticket's and its sub-tickets' are counted apart. */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    tokens: a.tokens + b.tokens,
    costUsd: a.costUsd + b.costUsd,
    runs: a.runs + b.runs,
  };
}

/** The rows grouped by a key, each group's totals, largest cost first, then by key. */
export function groupTotals(
  rows: readonly RunUsageRow[],
  keyOf: (r: RunUsageRow) => string,
): { key: string; totals: UsageTotals }[] {
  const groups = new Map<string, RunUsageRow[]>();
  for (const r of rows) {
    groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  }

  return [...groups]
    .map(([key, group]) => ({ key, totals: totalsOf(group) }))
    .toSorted((a, b) => b.totals.costUsd - a.totals.costUsd || a.key.localeCompare(b.key));
}
