import type { CanonicalStatus, Condition } from "@outstaff/core";
import type { PipelineEventType } from "./events.types.js";

/**
 * A person a decision names. `author` (of the pull request), `assignee` (of the ticket), `mentioned` (the first agent
 * the comment names), `doc_author`, `last_worker` (the agent who last worked on the ticket), `role:<role>`, as the
 * conditions' evaluator resolves them; plus `actor` (the agent who caused the event) and `addressed` (the agent a chat message
 * was written to).
 */
export type PersonRef =
  | "author"
  | "assignee"
  | "mentioned"
  | "doc_author"
  | "last_worker"
  | "actor"
  | "addressed"
  | `role:${string}`;

/** One person, or a list tried in order: the first that resolves to a team agent. */
export type PersonSpec = PersonRef | readonly PersonRef[];

/** A condition only the pipeline knows: the event's actor is that person (for example the assignee themselves). */
export type PipelineLeaf = { actor_is: "assignee" | "author" | "doc_author" | "last_worker" };

/** A condition, a pipeline leaf, or a combination of them. */
export type PipelineCondition =
  | Condition
  | PipelineLeaf
  | { all: PipelineCondition[] }
  | { any: PipelineCondition[] }
  | { not: PipelineCondition };

/**
 * One tracker change of an act. `assign: requester` is the human who asked for the work (else the team's first
 * human), `assign: self` the acting agent; `comment` is a template rendered like an instruction; `set_parent` sets the
 * parent ticket the event names in `data.parent`.
 */
export type OpSpec =
  | { move: CanonicalStatus }
  | { assign: "requester" | "self" }
  | { comment: string }
  | { set_parent: true };

export type DecideSpec =
  | { wake: { person: PersonSpec; kind: string; subject?: "event" | "next_ready_ticket" } }
  | {
      /** `wake`: then wake the agent acted for, with the policy's instruction; the act posts no note. */
      act: { as: PersonSpec; ops: OpSpec[]; wake?: { kind: string } | undefined };
    }
  | { drop: { reason: string } };

export interface Policy {
  id: string;

  /** One line for `ost explain` and the docs. */
  summary: string;
  on: readonly PipelineEventType[];
  when?: PipelineCondition | undefined;
  decide: DecideSpec;

  /**
   * A template with {{variable}} placeholders: for a wake, the instruction the agent is given; for an act, the comment
   * the office posts with its changes, saying whom they are for; for an act that then wakes, the wake's instruction.
   */
  instruction?: string | undefined;

  /** False turns the policy off; it is still listed in the trace. Default true. */
  enabled?: boolean | undefined;
}

export interface ConditionResult {
  ok: boolean;
  detail: string;

  /** When it does not hold: the innermost condition that decided that. */
  failed?: PipelineCondition | undefined;
}
