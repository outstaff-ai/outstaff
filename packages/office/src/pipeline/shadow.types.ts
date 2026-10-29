import type { Logger, TeamConfig, WorkflowEvent } from "@outstaff/core";
import type { EffectOutcome } from "#/engine/types.js";
import type { EngineRecord } from "./compare/compare.types.js";
import type { Clock } from "#/types.js";
import type { PipelineEvent } from "./events.types.js";
import type { PipelineState } from "./state.types.js";
import type { Trace, TraceStore } from "./trace.types.js";

export interface ShadowOptions {
  team: TeamConfig;

  /** The office's work state, after it applied the event. */
  state: PipelineState;
  traces: TraceStore;
  clock: Clock;
  logger: Logger;
}

/** Judges office events with the pipeline. */
export interface PipelineRunner {
  /** Never throws: a failure is logged, so the office's own handling is never held up. */
  handle(
    event: WorkflowEvent,
    meta: { source: string; externalId: string },
  ): Promise<Trace | undefined>;

  /** Judges an event the office raised itself (`agent.idle`), which has no workflow event behind it. */
  judge(event: PipelineEvent): Promise<Trace | undefined>;
}

/** Runs office events through the pipeline and records only the trace: nothing is scheduled or changed. */
export interface ShadowPipeline extends PipelineRunner {
  /**
   * Adds to the event's trace what the engine applied for it, and how that compares with the pipeline's decisions.
   * Never throws.
   */
  engineDid(
    meta: { source: string; externalId: string },
    outcomes: readonly EffectOutcome[],
  ): Promise<Trace | undefined>;

  /**
   * Adds to the event's trace what the office's own handling did for it (the engine's outcomes, or what the chat desk
   * did with a message), and how that compares with the pipeline's decisions. Never throws.
   */
  compare(
    meta: { source: string; externalId: string },
    record: () => EngineRecord,
  ): Promise<Trace | undefined>;
}
