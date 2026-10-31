import type { Capability, Logger, TeamConfig } from "@outstaff/core";
import type { ConfiguredPolicy } from "@outstaff/policy";
import type { QueuedAct } from "@outstaff/protocol";
import type { Clock } from "#/types.js";
import type { Scheduler } from "#/scheduler/index.js";
import type { Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/index.js";
import type { ActDesk } from "./act/act.types.js";
import type { PipelineRunner } from "./runner.types.js";
import type { TraceStore } from "./trace.types.js";

export interface OfficePipelineOptions {
  team: TeamConfig;
  store: Store;
  workState: WorkState;
  scheduler: Pick<Scheduler, "enqueue">;

  /** Sends an act to the person's agent; false when it is not connected. */
  push(person: string, act: QueuedAct): boolean;
  clock: Clock;
  logger: Logger;

  /** The team's custom policies, loaded; they run after the built-in ones. */
  policies?: readonly ConfiguredPolicy[] | undefined;

  /** What the team's integrations can do: the capabilities of the adapters it configures. None known when unset. */
  capabilities?: readonly Capability[] | undefined;
}

/**
 * The event pipeline as the office runs it: the runner that judges each event, where its traces are kept, and the desk
 * that hands its acts to agents.
 */
export interface OfficePipeline {
  runner: PipelineRunner;
  traces: TraceStore;
  acts: ActDesk;
}
