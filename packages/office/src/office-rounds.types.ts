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

  /** Called after work was queued for a person, so the protocol server can offer it at once. */
  notify?: (person: string) => void;
}

export interface OfficeRounds {
  /**
   * After an item was handed back: gives what reached it while it ran one more round, so the agent sees it. That is
   * the feedback attached after its last offer (`policies.feedback.follow_up_round`) and the answers to its questions
   * that came while it ran, all in one round: a waiting item is queued again, a finished one gets one follow-up.
   * Idempotent.
   */
  followUp(itemId: string): Promise<void>;

  /**
   * After an item was handed back: when it finished the work on a ticket that is not blocked, the same person's earlier
   * blocked items on that ticket are closed (canceled), so none is left orphaned. Idempotent.
   */
  settle(item: WorkItem): Promise<void>;
}
