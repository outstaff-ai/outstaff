import type {
  Chat,
  Effect,
  Logger,
  ResolvedWorkflow,
  TeamConfig,
  Tracker,
  WorkflowEvent,
} from "@outstaff/core";
import type { Clock } from "../clock.js";
import type { IntakeMeta } from "../intake/index.js";
import type { Scheduler } from "../scheduler/index.js";
import type { Store } from "../store/index.js";
import type { WorkState, WorkstateMeta } from "../workstate/index.js";

export interface EngineOptions {
  store: Store;
  workState: WorkState;
  scheduler: Pick<Scheduler, "enqueue">;
  team: TeamConfig;
  clock: Clock;
  logger: Logger;

  /** Without a tracker, move, assign and comment effects are skipped (and noted); scheduling still works. */
  ports?: { tracker?: Tracker; chat?: Chat };

  /** Defaults to `resolveWorkflow(team.workflow)`. */
  workflow?: ResolvedWorkflow;

  /** Where `notify` effects aimed at "the channel" go. Defaults to `integrations.chat.channel` when set. */
  channel?: string;
}

export type EffectStatus = "applied" | "skipped" | "failed";

export interface EffectOutcome {
  effect: Effect;
  status: EffectStatus;

  /** Why an effect was skipped or failed, or what it did. */
  note: string;
  at: string;
}

export type EngineMeta = IntakeMeta | WorkstateMeta;

export interface Engine {
  /**
   * Register as an intake handler after the work state's `apply` (so the state already reflects the event),
   * and as a work state `onEvent` handler. Idempotent under redelivery.
   */
  handle(event: WorkflowEvent, meta: EngineMeta): Promise<EffectOutcome[]>;
}
