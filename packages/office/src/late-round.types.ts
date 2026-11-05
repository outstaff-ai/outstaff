import type { Feedback } from "@outstaff/protocol";
import type { Scheduler } from "./scheduler/index.js";
import type { Conversation, Store } from "./store/types.js";

export interface LateRoundOptions {
  store: Store;
  scheduler: Pick<Scheduler, "enqueue">;
}

/** What reached a work item that its agent has not seen: feedback after its offer, answers after it asked. */
export interface LateInput {
  feedback: Feedback[];

  /** Answered questions of the item, not yet handed to it. */
  answers: Conversation[];
}
