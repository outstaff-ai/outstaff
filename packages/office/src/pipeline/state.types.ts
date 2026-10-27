import type { EvaluationContext, WorkflowOptions, WorkflowState } from "@outstaff/core";
import type { ReadyTicket } from "../workstate/index.js";
import type { PipelineEvent } from "./events.types.js";
import type { Policy } from "./policy.types.js";

export type { ReadyTicket } from "../workstate/index.js";

/** The world a policy is judged against: the workflow rules' state plus what the pipeline adds. */
export interface PipelineState extends WorkflowState {
  /** Ready tickets assigned to the agent that it has not picked up yet, in any order. */
  readyTickets(person: string): ReadyTicket[];
}

export interface PipelineOptions extends WorkflowOptions {
  /** The handles of the team's agents; a decision for anyone else is dropped. */
  people: readonly string[];
}

export interface ConfiguredPipeline {
  policies: Policy[];
  options: PipelineOptions;

  /** What in `pipeline.policies` was ignored, and why. */
  issues: string[];
}

export interface DecideInput {
  event: PipelineEvent;
  ctx: EvaluationContext;
  state: PipelineState;
  opts: PipelineOptions;
}
