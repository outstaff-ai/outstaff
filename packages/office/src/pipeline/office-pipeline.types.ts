import type { Knowledge, Logger, TeamConfig, Tracker, WorkflowEvent } from "@outstaff/core";
import type { EffectOutcome } from "#/engine/types.js";
import type { Clock } from "#/types.js";
import type { Scheduler } from "#/scheduler/index.js";
import type { Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/index.js";
import type { PipelineEvent } from "./events.types.js";
import type { PipelineRunner } from "./shadow.types.js";
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

/** The event pipeline as the office runs it, per `office.pipeline`. */
export interface OfficePipeline {
  mode: "off" | "shadow" | "live";

  /** The shadow or live runner; absent when the pipeline is off. */
  runner?: PipelineRunner | undefined;
  traces: TraceStore;

  /**
   * Has an event judged: by the engine alone when off; by the pipeline first and then the engine in shadow mode (both
   * see the same state, the pipeline only records, and what the engine applied is added to its trace); by the pipeline
   * alone when live.
   */
  route(
    event: WorkflowEvent,
    meta: { source: string; externalId: string },
    engine: () => Promise<EffectOutcome[]>,
  ): Promise<unknown>;

  /**
   * Has an idle agent's `agent.idle` judged: `pull` (the scheduler's own idle pull) alone when off; traced and then
   * `pull` in shadow mode; by the pipeline alone when live.
   */
  idle(event: PipelineEvent, pull: () => Promise<unknown>): Promise<unknown>;
}
