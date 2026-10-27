import type { Logger, TeamConfig } from "@outstaff/core";
import type { Clock } from "#/types.js";
import type { Scheduler } from "#/scheduler/index.js";
import type { Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/index.js";
import type { ActExecutor } from "#/pipeline/act/act.types.js";
import type { TraceStore } from "#/pipeline/trace.types.js";

/** Why a work item was queued by the live pipeline: the event and the policy. Kept per item for the office link. */
export interface WakeReason {
  event: string;
  policy: string;
}

export interface LiveOptions {
  team: TeamConfig;
  store: Pick<Store, "listItems" | "upsertSubject" | "getSubject" | "appendJournal">;
  workState: WorkState;
  scheduler: Pick<Scheduler, "enqueue">;
  executor: ActExecutor;
  traces: TraceStore;
  clock: Clock;
  logger: Logger;
}
