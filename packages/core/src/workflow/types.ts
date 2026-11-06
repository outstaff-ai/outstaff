import type { TeamConfig } from "#/config/types.js";
import type { InitiativeRef } from "#/ports/initiative.js";
import type { CanonicalStatus, RepoRef } from "#/ports/types.js";
import type { HAND_BACK_STATUSES, WORKFLOW_EVENT_TYPES } from "./constants.js";

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

/** Every event the office takes in: the workflow events and chat messages. */
export type OfficeEventType = WorkflowEventType | "chat.message";

export type ActorKind = "human" | "agent" | "automation";

export interface PrRef {
  repo: RepoRef;
  number: number;
}

/** A normalized event. The office maps tracker, VCS and agent events onto this shape. */
export interface WorkflowEvent {
  type: OfficeEventType;

  /** `chat` is the conversation a `chat.message` was written in: the channel and, unless it is the whole of a direct message, the thread. */
  subject: {
    ticket?: string;
    pr?: PrRef;
    doc?: string;
    chat?: { channel: string; thread?: string | undefined };
  };
  actor: { kind: ActorKind; id: string };

  /**
   * Event specific data. `ticket.moved` carries `to` (and `from`) as canonical statuses;
   * `pr.review_submitted` carries `state` (for example "approved" or "changes_requested"). `doc.commented`
   * carries `docId`, `title`, `commentId`, `anchorText` and `url` of a comment or reply on a knowledge document;
   * its subject is the document and, when the work state knows it, the ticket the document was written for.
   * `ticket.unblocked` carries `blocker`, the ticket whose close left none open, and `closedBy`, who closed it, when known;
   * when the ticket and its blocker are subtasks of one parent, `parent` and, when an agent holds it, `parentAgent`.
   * `ticket.closed` carries `status` (`done` or `canceled`), `at`, when it closed, and `closedBy`, who closed it, when known.
   * `pr.merge_checks_passed` and `pr.merge_checks_failed` carry `sha`, the merge commit, and `base`; the failure also
   * carries `failing` (each check's `name` and `url`) and `timedOut` when a check was still running at the timeout.
   */
  data: Record<string, unknown>;
}

/** The latest decisive review one reviewer left on a pull request (a comment-only review decides nothing). */
export interface PrVerdict {
  /** Login of a human, handle of an agent. */
  actor: string;
  kind: ActorKind;
  state: "approved" | "changes_requested" | "dismissed";
}

export interface WorkflowPr {
  ref: PrRef;
  title: string;
  url?: string;
  headRef: string;

  /** The commit its branch points at, when the office has read it. */
  head?: string;
  baseRef: string;
  draft: boolean;
  state: "open" | "closed" | "merged";

  /** `person` is the agent's handle when the author is one of our agents. */
  author: { login: string; kind: "human" | "agent" | "bot"; person?: string };

  /** Latest decisive review of each reviewer the office trusts. */
  verdicts?: PrVerdict[];

  /** Combined state of its checks on the current head, when the office has read them. */
  ci?: "none" | "pending" | "success" | "failure";
}

/**
 * Whom a ticket is assigned to. For agents `id` is the person handle. `names` are the ones the tracker knows the
 * member by (its id, username and display name): an act may name the member by any of them.
 */
export interface TicketAssignee {
  id: string;
  kind: "human" | "agent";
  names?: string[] | undefined;
}

/** Read-only snapshot of the office's world, taken after the event happened. */
export interface WorkflowState {
  ticketForPr(pr: PrRef): string | undefined;

  /** Canonical status of the ticket. */
  ticketStatus(ticket: string): CanonicalStatus | undefined;

  /**
   * The status the ticket had at that time (ISO-8601), as far as the state knows: the status before its latest change
   * for a time before that change, else its status now.
   */
  ticketStatusAt(ticket: string, at: string): CanonicalStatus | undefined;

  assignee(ticket: string): TicketAssignee | undefined;
  pullRequest(pr: PrRef): WorkflowPr | undefined;

  /** Every pull request linked to the ticket, in any state. */
  pullRequestsOf(ticket: string): WorkflowPr[];

  /** True while the agent's latest work on the ticket ended as a hand-back as done. */
  handedBack(ticket: string): boolean;

  /** Handle of the agent who last worked on the ticket. */
  lastWorker(ticket: string): string | undefined;

  /**
   * Handle of the agent blocked on the ticket: while it is blocked, the agent whose latest work on it was handed back
   * as blocked (or as done after the agent moved it to blocked). An unblock round or another agent's round does not
   * change it.
   */
  blockedAgent(ticket: string): string | undefined;

  /** The tickets that block the ticket and are still open (not done or canceled). */
  openBlockers(ticket: string): string[];

  /** Whether the agent had a round on the ticket under way at that time (ISO-8601). */
  inRound(ticket: string, person: string, at: string): boolean;

  /** Id of the human who asked for the work. */
  requester(ticket: string): string | undefined;
  hasLabel(ticket: string, label: string): boolean;

  /** The branch pull requests of the repository target by default (`repos[].default_branch`). */
  defaultBranch(repo: RepoRef): string;

  /** Open pull requests whose base is `branch`. */
  stackedOn(repo: RepoRef, branch: string): WorkflowPr[];

  /** Handle of the agent who wrote the document, as the work state recorded it. */
  docAuthor(doc: string): string | undefined;

  /** Handle of the agent playing a catalog role, if exactly one is configured. */
  personForRole(role: string): string | undefined;

  /** The ticket's parent ticket (it is a sub-ticket of), as the tracker last said. */
  parentOf(ticket: string): string | undefined;

  /** The ticket's sub-tickets the state knows, in any status. */
  subTickets(ticket: string): string[];

  /** The initiative (milestone) the ticket is in, as the tracker last said. */
  initiativeOf(ticket: string): InitiativeRef | undefined;

  /** The tickets the state knows in the initiative, by its id, in any status. */
  initiativeTickets(initiative: string): string[];
}

/**
 * What a condition reads of an event: its subject, actor and data. Only a comment's type is read (a ticket that closed
 * after the comment was written is judged open for it), so the office's event pipeline can check conditions on event
 * types of its own (`agent.idle`, the merge-derived events).
 */
export interface ConditionEvent {
  type: string;
  subject: WorkflowEvent["subject"];
  actor: WorkflowEvent["actor"];
  data: Record<string, unknown>;
}

/** An event with the ticket and pull request it is about, as conditions and people are resolved against. */
export interface EvaluationContext {
  event: ConditionEvent;
  state: WorkflowState;
  opts: WorkflowOptions;
  ticket: string | undefined;
  pr: WorkflowPr | undefined;
}

/** Whether a condition holds, and why. */
export interface ConditionCheck {
  ok: boolean;
  detail: string;
}

export interface WorkflowOptions {
  /** Label meaning "leave this to a human". Default `needs-human`. */
  needsHumanLabel?: string;

  /** `policies.merge.approvers`: who counts for the `approver` condition. */
  approvers?: string[];

  /** The team's `humans`, for matching `human:<id>` approvers. */
  humans?: TeamConfig["humans"];

  /** Who a ticket goes back to when no requester is known: the tracker identity of the first listed human who has one. */
  fallbackRequester?: string;
}

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { ticket_status: CanonicalStatus[] }
  | { parent_status: CanonicalStatus[] }
  | { moved_to: CanonicalStatus[] }
  | { actor_kind: "human" | "agent" | "automation" }
  | { assignee_kind: "human" | "agent" | "none" }
  | { has_label: string }
  | { pr_author_kind: "human" | "agent" | "bot" }
  | { approver: boolean }
  | { pr_draft: boolean }
  | { pr_open: boolean }
  | { pr_merged: boolean }
  | { pr_base_default: boolean }
  | { has_body: boolean }
  | { agent_mentioned: boolean }
  | { review_state: string[] }
  | { hand_back_status: HandBackStatus[] }
  | { work_kind: string[] }
  | { pr_approved: boolean }
  | { ticket_prs_all_closed: boolean }
  | { ticket_prs_open: boolean }
  | { ticket_prs_several: boolean }
  | { ticket_handed_back: boolean }
  | { open_subtickets: boolean }
  | { in_milestone: boolean }
  | { blocked_agent: boolean }
  | { open_blockers: boolean }
  | { actor_in_round: boolean }
  | { work_from_chat: boolean };

export type HandBackStatus = (typeof HAND_BACK_STATUSES)[number];

export interface StaticTicket {
  status: CanonicalStatus;

  /** When it entered its status, and the status it had before (ISO-8601). */
  statusSince?: string;
  previousStatus?: CanonicalStatus;
  assignee?: TicketAssignee;
  lastWorker?: string;
  requester?: string;
  labels?: string[];

  /** The agent's latest work on the ticket ended as a hand-back as done. */
  handedBack?: boolean;

  /** The agent blocked on the ticket. */
  blockedAgent?: string;

  /** The tickets that block it and are still open. */
  openBlockers?: string[];

  /** The agents' rounds on the ticket. */
  rounds?: StaticRound[];

  /** The ticket it is a sub-ticket of. */
  parent?: string;

  /** The initiative (milestone) it is in. */
  initiative?: InitiativeRef;
}

/** One agent's round on a ticket: from when it was queued until it ended (ISO-8601), still under way without `to`. */
export interface StaticRound {
  person: string;
  from: string;
  to?: string;
}

export interface StaticWorkflowData {
  tickets?: Record<string, StaticTicket>;
  prs?: WorkflowPr[];

  /** Pull request number -> ticket key (same repo assumed per entry's `ref.repo`). */
  links?: Record<number, string>;
  roles?: Record<string, string>;

  /** The repositories' default branch; `main` when unset. */
  defaultBranch?: string;

  /** Document id -> handle of the agent who wrote it. */
  docs?: Record<string, string>;
}

export interface WorkflowStatusMap {
  /** The tracker's name for a canonical status. */
  toTracker(status: CanonicalStatus): string;

  /** Canonical status for a tracker name (case-insensitive), or undefined if unmapped. */
  toCanonical(name: string): CanonicalStatus | undefined;
}
