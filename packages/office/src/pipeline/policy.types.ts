import type { CanonicalStatus, Condition } from "@outstaff/core";
import type { PipelineEventType } from "./events.types.js";

/**
 * A person a decision names. `author` (of the pull request), `assignee` (of the ticket), `mentioned` (the first agent
 * the comment names), `doc_author`, `role:<role>`, as the workflow rules resolve them; plus `actor` (the agent who
 * caused the event) and `addressed` (the agent a chat message was written to).
 */
export type PersonRef =
  | "author"
  | "assignee"
  | "mentioned"
  | "doc_author"
  | "actor"
  | "addressed"
  | `role:${string}`;

/** One person, or a list tried in order: the first that resolves to a team agent. */
export type PersonSpec = PersonRef | readonly PersonRef[];

/** A condition only the pipeline knows: the event's actor is that person (for example the assignee themselves). */
export type PipelineLeaf = { actor_is: "assignee" | "author" | "doc_author" };

/** A workflow rule condition, a pipeline leaf, or a combination of them. */
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
  | { act: { as: PersonSpec; ops: OpSpec[] } }
  | { drop: { reason: string } };

export interface Policy {
  id: string;

  /** One line for `ost explain` and the docs. */
  summary: string;
  on: readonly PipelineEventType[];
  when?: PipelineCondition | undefined;
  decide: DecideSpec;

  /** The wake instruction, a template with {{variable}} placeholders. Only wake policies have one. */
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
