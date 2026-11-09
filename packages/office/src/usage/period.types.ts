import type { PeriodGroup } from "@outstaff/protocol";
import type { ModelCounts, PeriodRun, RunUsageRow, Store } from "#/store/types.js";

export type CalendarUnit = "day" | "month";

/** A part of an interval that falls in one local day or month: `[from, to)` in ms, and that day or month. */
export interface CalendarPiece {
  from: number;
  to: number;
  key: string;
}

/** The period asked for, checked: its edges in ms, the time zone and the keys of the groups. */
export interface Period {
  from: number;
  to: number;
  tz: string;
  groupBy: readonly PeriodGroup[];

  /** The office's time: where a run that is still going ends for now. */
  now: number;
}

/** One model's usage on a run, as the totals count it. */
export type RunCounts = ModelCounts & Pick<RunUsageRow, "runId">;

/** The part of a run in one day or month of the period, with its share of the run's usage. */
export interface RunPiece {
  run: PeriodRun;
  from: number;
  to: number;

  /** The local day (`YYYY-MM-DD`) or month (`YYYY-MM`) it falls in; empty when the period is not split. */
  date: string;
  usage: RunCounts[];
}

export type PeriodUsageStore = Pick<Store, "listPeriodRuns" | "listRunUsage">;
