import type { ActOp, Logger } from "@outstaff/core";
import type { PipelineEvent, PolicyState } from "@outstaff/policy";
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

/** The changes acts were sent to make, kept until the tracker reports them back. */
export interface ActEchoes {
  /** Expects each tracker change of the act back, made by the person, from now on. */
  expect(person: string, act: PendingAct): Promise<void>;

  /**
   * The id of the act whose change the event reports, once: the tracker's echo of it. Undefined for any other event.
   * `state` is the work state after the event, the one the policies judge it against.
   */
  of(event: PipelineEvent, state: PolicyState): Promise<string | undefined>;
}

/** Hands acts to the agents that make them; the protocol server and messaging use it. */
export interface ActDesk {
  /** Queues the act for the person's agent and sends it now when the agent is connected. */
  send(person: string, act: PendingAct): Promise<void>;

  /** The person's unanswered acts, for the `welcome`; their traces say delivered. */
  deliver(person: string): Promise<QueuedAct[]>;

  /** The agent's answer: the act leaves the queue, its trace gets the result, and the tickets it changed are read again. */
  result(person: string, result: PayloadOf<"act_result">): Promise<void>;

  /** The act whose tracker change the event reports, if it is one: see `ActEchoes.of`. */
  echoOf: ActEchoes["of"];
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
