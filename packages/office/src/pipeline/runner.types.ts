import type { WorkflowEvent } from "@outstaff/core";
import type { PipelineEvent } from "./events.types.js";
import type { Trace } from "./trace.types.js";

/** Judges office events with the pipeline and carries out what it decides. */
export interface PipelineRunner {
  /** Judges an office event; undefined for a type the pipeline does not decide on. */
  handle(
    event: WorkflowEvent,
    meta: { source: string; externalId: string },
  ): Promise<Trace | undefined>;

  /** Judges an event the office raised itself (`agent.idle`), which has no workflow event behind it. */
  judge(event: PipelineEvent): Promise<Trace>;
}
