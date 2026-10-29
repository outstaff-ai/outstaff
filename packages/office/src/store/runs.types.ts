export interface Run {
  id: string;
  workItemId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  error: string | null;
  usage: unknown;

  /** The runtime adapter that ran it; null until the agent reports it. */
  runtime: string | null;

  /** The concrete model it ran, when the agent or the runtime reported one; null for the runtime's unnamed default. */
  model: string | null;
}

/** What the agent reports about the runtime of a run; a field left out keeps what the run has. */
export interface RunRuntime {
  runtime?: string | undefined;
  model?: string | undefined;
}
