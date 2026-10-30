import type { Logger, TeamConfig } from "@outstaff/core";
import type { Scheduler } from "./scheduler/index.js";
import type { Store, WorkItem } from "./store/types.js";
import type { WorkState } from "./workstate/index.js";

export interface OfficeRoundsOptions {
  store: Store;
  scheduler: Pick<Scheduler, "enqueue">;
  workState: Pick<WorkState, "ticket">;
  team: Pick<TeamConfig, "policies">;
  logger: Pick<Logger, "info">;
}

export interface OfficeRounds {
  /**
   * After an item was handed back: queues one more round for the feedback that was attached to it after its last
   * offer, so the agent never saw it (`policies.feedback.follow_up_round`). Idempotent.
   */
  followUp(itemId: string): Promise<void>;

  /**
   * After an item was handed back: when it finished the work on a ticket that is not blocked, the same person's earlier
   * blocked items on that ticket are closed (canceled), so none is left orphaned. Idempotent.
   */
  settle(item: WorkItem): Promise<void>;
}
