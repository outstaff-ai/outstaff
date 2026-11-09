/** Tokens and cost of one model. `costUsd` is null when the runtime had no price for the model. */
export interface ModelCounts {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
}

/** One model's usage in one run, with the run's work item, person, kind and end. */
export interface RunUsageRow extends ModelCounts {
  runId: string;
  workItemId: string;
  person: string;
  kind: string;

  /** When the run finished; null while it runs. */
  finishedAt: string | null;
}

/** Which usage rows to read; every filter given must match. */
export interface RunUsageFilter {
  workItemIds?: readonly string[];
  runIds?: readonly string[];

  /** Runs that finished at or after this time (ISO-8601). */
  since?: string;

  /** Runs that finished before this time. */
  until?: string;

  /** Runs that were going at some time from `from` up to `to`, not included. */
  runningIn?: { from: string; to: string };
}

/** A run that was going at some time in a period, with its work item's person and subject. */
export interface PeriodRun {
  runId: string;
  workItemId: string;
  person: string;
  subject: { type: string; ref: string } | null;
  startedAt: string;

  /** When the run finished; null while it runs. */
  finishedAt: string | null;
}

export interface UsageStore {
  /**
   * Adds a session's latest running totals to the run: what is new since the session's previous report goes on the
   * run (a total below the previous one started over, and counts whole), and the report becomes the session's latest.
   * Returns what went on the run.
   */
  recordRunUsage(runId: string, session: string, models: ModelCounts[]): Promise<ModelCounts[]>;
  listRunUsage(filter: RunUsageFilter): Promise<RunUsageRow[]>;

  /** The runs that were going at some time from `from` up to `to` (ISO-8601, `to` not included), oldest first. */
  listPeriodRuns(from: string, to: string): Promise<PeriodRun[]>;

  /** Ids of the work items whose subject is the ticket or whose references name it, oldest first. */
  itemsOfTicket(ticket: string): Promise<string[]>;

  /** Ids of the work items whose subject and references name no ticket, oldest first. */
  itemsWithoutTicket(ids: readonly string[]): Promise<string[]>;
}
