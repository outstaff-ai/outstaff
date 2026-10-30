import type { ActOp, Logger } from "@outstaff/core";
import type { PayloadOf, QueuedAct } from "@outstaff/protocol";
import type { Clock } from "#/types.js";
import type { Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/index.js";
import type { Act } from "#/pipeline/decisions.types.js";
import type { TraceStore } from "#/pipeline/trace.types.js";

/** Carries out the acts a live pipeline decides, and records their progress on the event's trace. */
export interface ActExecutor {
  execute(act: Act, eventId: string): Promise<void>;
}

/** An act waiting for its agent's answer. */
export interface PendingAct {
  id: string;
  ops: ActOp[];

  /** The event whose trace records the act; none for an act made outside the pipeline. */
  event?: string | undefined;
}

/** Acts per person, kept until the agent answers. */
export interface ActQueue {
  /** Keeps the act until `take`; an id the person already has is kept once. */
  add(person: string, act: PendingAct): Promise<void>;
  list(person: string): Promise<PendingAct[]>;

  /** Removes the act and returns it; undefined for an id the person does not have. */
  take(person: string, id: string): Promise<PendingAct | undefined>;
}

/** Hands acts to the agents that make them; the protocol server and messaging use it. */
export interface ActDesk {
  /** Queues the act for the person's agent and sends it now when the agent is connected. */
  send(person: string, act: PendingAct): Promise<void>;

  /** The person's unanswered acts, for the `welcome`; their traces say delivered. */
  deliver(person: string): Promise<QueuedAct[]>;

  /** The agent's answer: the act leaves the queue, its trace gets the result, and the tickets it changed are read again. */
  result(person: string, result: PayloadOf<"act_result">): Promise<void>;
}

export interface ActDeskOptions {
  store: Pick<Store, "getSubject" | "upsertSubject">;
  traces: TraceStore;
  workState: Pick<WorkState, "refreshTicket">;
  clock: Clock;
  logger: Logger;

  /** Sends an act to the person's agent; false when it is not connected. */
  push(person: string, act: QueuedAct): boolean;
}
