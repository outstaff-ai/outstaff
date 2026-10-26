import type {
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
import type { Store, WorkItem } from "../store/index.js";
import type { WorkState, WorkstateMeta } from "../workstate/index.js";

export interface EngineOptions {
  store: Store;
  workState: WorkState;
  scheduler: Pick<Scheduler, "enqueue" | "retry">;
  team: TeamConfig;
  clock: Clock;
  logger: Logger;

  /** Without a tracker, move, assign and comment effects are skipped (and noted); scheduling still works. */
  ports?: { tracker?: Tracker };

  /** Defaults to `resolveWorkflow(team.workflow, team.humans, team.policies)`. */
  workflow?: ResolvedWorkflow;
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

  /**
   * After an item was handed back: queues one more round for the feedback that was attached to it after its last
   * offer, so the agent never saw it. Idempotent.
   */
  followUp(itemId: string): Promise<void>;

  /**
   * After an item started: a ticket a chat session attached to the agent's earlier work, which may have been
   * reassigned to the requester since, is assigned to the agent again. Idempotent; failures are logged.
   */
  started(itemId: string): Promise<void>;

  /**
   * After an item was handed back: when it finished the work on a ticket that is not blocked, the earlier blocked
   * items on that ticket are closed (canceled), so none is left orphaned. Idempotent.
   */
  settled(item: WorkItem): Promise<void>;

  /**
   * An item the scheduler blocked (loop guard, stale twice, too many failures): when the team routes blocked work to
   * its PM, queues an `unblock` round for the PM with the reason as data. Returns whether a round was queued or
   * joined; false when the team has no PM, the PM is the blocked person, the item has no ticket, or the switch says
   * the agent reports it.
   */
  unblock(item: WorkItem, reason: string): Promise<boolean>;
}
