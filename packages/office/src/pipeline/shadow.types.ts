import type { Logger, TeamConfig, WorkflowEvent, WorkflowState } from "@outstaff/core";
import type { Clock } from "../types.js";
import type { Trace, TraceStore } from "./trace.types.js";

export interface ShadowOptions {
  team: TeamConfig;

  /** The office's work state, after it applied the event. */
  state: WorkflowState;
  traces: TraceStore;
  clock: Clock;
  logger: Logger;
}

/** Runs office events through the pipeline and records only the trace: nothing is scheduled or changed. */
export interface ShadowPipeline {
  /** Never throws: a failure is logged, so the office's own handling is never held up. */
  handle(
    event: WorkflowEvent,
    meta: { source: string; externalId: string },
  ): Promise<Trace | undefined>;
}
