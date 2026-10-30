import type { Knowledge, Logger, TeamConfig, Tracker } from "@outstaff/core";
import type { Clock } from "#/types.js";
import type { Scheduler } from "#/scheduler/index.js";
import type { Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/index.js";
import type { PipelineRunner } from "./runner.types.js";
import type { TraceStore } from "./trace.types.js";

export interface OfficePipelineOptions {
  team: TeamConfig;
  store: Store;
  workState: WorkState;
  scheduler: Pick<Scheduler, "enqueue">;
  ports: { tracker?: Tracker | undefined; knowledge?: Knowledge | undefined };
  clock: Clock;
  logger: Logger;
}

/** The event pipeline as the office runs it: the runner that judges each event, and where its traces are kept. */
export interface OfficePipeline {
  runner: PipelineRunner;
  traces: TraceStore;
}
