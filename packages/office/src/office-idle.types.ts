import type { Logger, TeamConfig, WorkflowEvent } from "@outstaff/core";
import type { PipelineRunner } from "./pipeline/runner.types.js";
import type { Scheduler } from "./scheduler/index.js";
import type { Store } from "./store/types.js";
import type { Clock } from "./types.js";
import type { WorkState } from "./workstate/index.js";

export interface IdlePullOptions {
  team: Pick<TeamConfig, "people" | "policies">;
  store: Pick<Store, "listItems">;
  workState: Pick<WorkState, "refreshWorkers" | "readyTickets" | "assignee" | "ticketStatus">;

  /** The office's scheduler, which says whether the agent's automatic work is held. */
  scheduler: Pick<Scheduler, "isPausedFor">;
  pipeline: Pick<PipelineRunner, "judge">;
  clock: Clock;
  logger: Logger;
}

/** Raises `agent.idle` for an agent with nothing queued or running, and pulls its next ready ticket. */
export interface IdlePull {
  /** After a hand-back and when the agent connects. */
  check(person: string): Promise<void>;

  /** On the scheduler's tick: every agent of the team. */
  sweep(): Promise<void>;

  /**
   * After the office judged an event: a ticket created or assigned to an agent, or moved into ready, is checked for
   * its agent at once, instead of on the next tick.
   */
  afterEvent(event: WorkflowEvent): Promise<void>;
}
