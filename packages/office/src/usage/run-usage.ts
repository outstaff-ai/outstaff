import type { SessionUsageReport } from "@outstaff/protocol";
import type { ModelCounts, Store } from "#/store/types.js";

/** A session's report as the store counts it: one entry per model, an unknown cost null. */
const countsOf = (report: SessionUsageReport): ModelCounts[] =>
  Object.entries(report.models).map(([model, u]) => ({
    model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    costUsd: u.costUsd ?? null,
  }));

/**
 * Records a round's usage on the item's open run: for each session, what is new since that session's previous report.
 * False when the item has no open run.
 */
export async function recordRoundUsage(
  store: Pick<Store, "listRuns" | "recordRunUsage">,
  itemId: string,
  reports: readonly SessionUsageReport[],
): Promise<boolean> {
  const run = (await store.listRuns(itemId)).findLast((r) => r.finishedAt === null);
  if (!run) {
    return false;
  }

  for (const report of reports) {
    await store.recordRunUsage(run.id, report.session, countsOf(report));
  }

  return true;
}
