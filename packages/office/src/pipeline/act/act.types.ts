import type { Knowledge, TeamConfig, Tracker } from "@outstaff/core";
import type { Act } from "../decisions.types.js";
import type { TraceStore } from "../trace.types.js";

/** Carries out the acts a live pipeline decides, and records each result on the event's trace. */
export interface ActExecutor {
  execute(act: Act, eventId: string): Promise<void>;
}

export interface OfficeActExecutorOptions {
  team: Pick<TeamConfig, "people">;
  tracker?: Tracker | undefined;
  knowledge?: Knowledge | undefined;
  traces: TraceStore;
}
