import type { SessionUsage } from "@outstaff/core";
import type { SessionUsageReport } from "@outstaff/protocol";
import type { ItemRun } from "./work.types.js";

/** Keeps a session's latest running totals, as the runtime reported them when a run of the round finished. */
export function keepUsage(
  run: ItemRun,
  session: string | undefined,
  usage: SessionUsage | undefined,
) {
  if (session && usage) {
    run.usage.set(session, usage);
  }
}

/** The round's usage for the office: each session's latest totals, an unknown cost left out. */
export function usageReport(run: ItemRun): SessionUsageReport[] {
  return [...run.usage].map(([session, usage]) => ({
    session,
    models: Object.fromEntries(
      Object.entries(usage).map(([model, u]) => [
        model,
        {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheCreationTokens: u.cacheCreationTokens,
          ...(u.costUsd === undefined ? {} : { costUsd: u.costUsd }),
        },
      ]),
    ),
  }));
}
