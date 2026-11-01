import type {
  CanonicalStatus,
  Capability,
  Condition,
  Resolved,
  WorkflowOptions,
  WorkflowPr,
  WorkflowState,
} from "@outstaff/core";
import type { PipelineEvent, PipelineEventType } from "./events.types.js";
import type { ErrorProposal, Proposal } from "./proposal.types.js";

/**
 * A person a policy names. `author` (of the pull request), `assignee` (of the ticket), `mentioned` (the first agent
 * the comment names), `doc_author`, `last_worker` (the agent who last worked on the ticket), `blocked_agent` (the agent
 * blocked on the ticket), `role:<role>`, as the conditions' evaluator resolves them; plus `actor` (the agent who caused
 * the event) and `addressed` (the agent a chat message was written to).
 */
export type PersonRef =
  | "author"
  | "assignee"
  | "mentioned"
  | "doc_author"
  | "last_worker"
  | "blocked_agent"
  | "actor"
  | "addressed"
  | `role:${string}`;

/** One person, or a list tried in order: the first that resolves to a team agent. */
export type PersonSpec = PersonRef | readonly PersonRef[];

/** A condition only the pipeline knows: the event's actor is that person (for example the assignee themselves). */
export type PipelineLeaf = {
  actor_is: "assignee" | "author" | "doc_author" | "last_worker" | "blocked_agent";
};

/** A condition, a pipeline leaf, or a combination of them. */
export type PipelineCondition =
  | Condition
  | PipelineLeaf
  | { all: PipelineCondition[] }
  | { any: PipelineCondition[] }
  | { not: PipelineCondition };

export interface ConditionResult {
  ok: boolean;
  detail: string;

  /** When it does not hold: the innermost condition that decided that. */
  failed?: PipelineCondition | undefined;
}

/** A ticket ready for an agent that it has not picked up yet. */
export interface ReadyTicket {
  key: string;
  title?: string | undefined;

  /** When the ticket entered ready (ISO-8601). */
  readyAt: string;

  /** The tracker's priority, when it has one: 1 is the most urgent. */
  priority?: number | undefined;
}

/** The world a policy reads, after the event happened: the office's work state, read-only. */
export interface PolicyState extends WorkflowState {
  /** Ready tickets assigned to the agent that it has not picked up yet, in any order. */
  readyTickets(person: string): ReadyTicket[];
}

/** What the team's config tells the policies. */
export interface PolicyOptions extends WorkflowOptions {
  /** The handles of the team's agents; a proposal for anyone else is rejected. */
  people: readonly string[];

  /**
   * The repositories whose pull requests agents may merge (`policies.merge.repos`), as lowercase `owner/name`; every
   * repository when unset.
   */
  mergeRepos?: readonly string[] | undefined;

  /**
   * What the team's integrations can do: the capabilities of the adapters the team file configures, such as
   * `tracker.development`. Unknown, and so none, when unset.
   */
  capabilities?: readonly Capability[] | undefined;
}

/**
 * One bookkeeping change of an act. `assign: requester` is the human who asked for the work (else the team's first
 * human), `assign: self` the agent acted for, and any other person reference (`role:pm`, for example) the agent it
 * names; `set_parent` sets the parent ticket the event names in `data.parent`; `link_pr` shows the event's pull
 * request on the ticket (the tracker's `tracker.development`).
 */
export type OpSpec =
  | { move: CanonicalStatus }
  | { assign: "requester" | "self" | PersonRef }
  | { set_parent: true }
  | { link_pr: true };

/** What `ctx.wake` wakes: a person, the kind of run, and its subject (the event's, or the agent's next ready ticket). */
export interface WakeSpec {
  person: PersonSpec;
  kind: string;
  subject?: "event" | "next_ready_ticket" | undefined;
}

/** What `ctx.act` changes, for whom, and whether it then wakes them with the policy's instruction. */
export interface ActSpec {
  as: PersonSpec;
  ops: readonly OpSpec[];
  wake?: { kind: string } | undefined;

  /** The note posted with the changes, a template; the policy's instruction when not given. An empty one posts none. */
  note?: string | undefined;
}

/**
 * The read-only view a policy decides with. Every helper is pure: it reads the state and returns proposals or
 * results, and changes nothing.
 */
export interface PolicyContext {
  readonly event: PipelineEvent;
  readonly state: PolicyState;
  readonly options: PolicyOptions;

  /** The ticket the event is about, or the one its pull request is linked to. */
  readonly ticket: string | undefined;

  /** The event's pull request, as the work state has it. */
  readonly pr: WorkflowPr | undefined;

  /** The policy's settings from team.yaml (`policies.custom[].settings`); empty for a built-in policy. */
  readonly settings: Readonly<Record<string, unknown>>;

  /** The policy's instruction template, the team's replacement if it set one. */
  readonly instruction: string | undefined;

  /** Why the policy's `when` held, or `no condition`: the default reason of the helpers' proposals. */
  readonly matched: string;

  /** Whether a condition holds for the event, and why. */
  check(condition: PipelineCondition): ConditionResult;

  /** The team agent a spec names: the first of a list that resolves, or why none does. */
  person(spec: PersonSpec): Resolved<string>;

  /** Renders a template with the event's instruction variables; `person` and `next` fill the variables of that name. */
  render(template: string, extra?: { person?: string; next?: string }): Resolved<string>;

  /** Proposes waking a person with the policy's instruction, or a drop saying why no one can be woken. */
  wake(spec: WakeSpec, reason?: string): Proposal[];

  /** Proposes bookkeeping changes for an agent (and the wake after, if asked), or a drop saying why there are none. */
  act(spec: ActSpec, reason?: string): Proposal[];
}

/** A policy as its module writes it. `decide` is pure: it reads the context and returns proposals, nothing else. */
export interface PolicyDefinition {
  /** Lowercase letters, digits and underscores; unique across the built-in and custom policies. */
  id: string;

  /** One line for `ost explain` and the docs. */
  summary: string;

  /** The event types the policy receives from the bus. */
  on: readonly PipelineEventType[];

  /** Checked before `decide`: when it does not hold, the policy proposes nothing, and the trace says which part failed. */
  when?: PipelineCondition | undefined;

  /**
   * A template with {{variable}} placeholders: for a wake, the instruction the agent is given; for an act, the note
   * posted with its changes, in the agent's own voice. An act without one posts no note. A team can replace it, or
   * set one.
   */
  instruction?: string | undefined;

  /** What the policy decides, in one line, for the generated reference. */
  decides?: string | undefined;

  /** Settles two acts on the same ticket field: the higher wins; on a tie, the policy listed first. Default 0. */
  priority?: number | undefined;

  decide(event: PipelineEvent, ctx: PolicyContext): readonly Proposal[];
}

/** A policy `definePolicy` checked. */
export type Policy = Readonly<PolicyDefinition>;

/** A policy with the team's changes to it: on or off, its instruction and `when` replaced, and its settings. */
export interface ConfiguredPolicy extends Policy {
  /** False turns the policy off; it is still listed in the trace. Default true. */
  readonly enabled?: boolean | undefined;
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
}

/** What one policy made of one event: whether it matched, why, and what it proposed. */
export interface PolicyRun {
  policy: string;
  matched: boolean;

  /** Why it matched or did not: the event types it listens to, that it is off, or the deciding condition's detail. */
  reason: string;

  /** For a policy that listens to the event but did not match: the first condition that failed. */
  failed?: PipelineCondition | undefined;
  proposals: (Proposal | ErrorProposal)[];
}

/** What a policy is run against. */
export interface PolicyInput {
  event: PipelineEvent;
  state: PolicyState;
  options: PolicyOptions;
}
