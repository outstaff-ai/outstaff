import type { PeriodRun } from "#/store/types.js";
import { localDateIn, splitByCalendar } from "./calendar.js";
import type { CalendarUnit, Period, RunCounts, RunPiece } from "./period.types.js";

/** The finest calendar unit the groups need; none when they need neither days nor months. */
const unitOf = (groupBy: Period["groupBy"]): CalendarUnit | undefined => {
  if (groupBy.includes("day")) {
    return "day";
  }

  return groupBy.includes("month") ? "month" : undefined;
};

/**
 * One model's usage on the part of a run from `a` to `b`, in proportion to its time. The token counts are rounded
 * where the run is cut, so the parts of a run add up to it exactly.
 */
function shareOf(u: RunCounts, start: number, end: number, a: number, b: number): RunCounts {
  const length = end - start;
  const [fa, fb] = length === 0 ? [0, 1] : [(a - start) / length, (b - start) / length];
  const part = (n: number) => Math.round(n * fb) - Math.round(n * fa);
  return {
    ...u,
    inputTokens: part(u.inputTokens),
    outputTokens: part(u.outputTokens),
    cacheReadTokens: part(u.cacheReadTokens),
    cacheCreationTokens: part(u.cacheCreationTokens),
    costUsd: u.costUsd === null ? null : u.costUsd * (fb - fa),
  };
}

/** The run's parts in the period, cut at its edges and where a local day or month starts. None when it is outside. */
function piecesOf(
  run: PeriodRun,
  usage: readonly RunCounts[],
  period: Period,
  date: (ms: number) => string,
): RunPiece[] {
  const start = Date.parse(run.startedAt);
  const end = Math.max(start, run.finishedAt === null ? period.now : Date.parse(run.finishedAt));
  const from = Math.max(start, period.from);
  const to = Math.min(end, period.to);
  // A run that only touches an edge has no time in the period; one that took no time at all counts where it is.
  if (to < from || from >= period.to || (to === from && start !== end)) {
    return [];
  }

  return splitByCalendar(date, unitOf(period.groupBy), from, to).map((p) => ({
    run,
    from: p.from,
    to: p.to,
    date: p.key,
    usage: usage.map((u) => shareOf(u, start, end, p.from, p.to)),
  }));
}

/** Every run's parts in the period, each with its share of the run's usage. */
export function periodPieces(
  runs: readonly PeriodRun[],
  usage: readonly RunCounts[],
  period: Period,
): RunPiece[] {
  const date = localDateIn(period.tz);
  const byRun = Map.groupBy(usage, (u) => u.runId);
  return runs.flatMap((run) => piecesOf(run, byRun.get(run.runId) ?? [], period, date));
}
