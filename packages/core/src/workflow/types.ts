import type { TeamConfig } from "#/config/types.js";
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
  baseRef: string;
  draft: boolean;
  state: "open" | "closed" | "merged";

  /** `person` is the agent's handle when the author is one of our agents. */
  author: { login: string; kind: "human" | "agent" | "bot"; person?: string };

  /** Latest decisive review of each reviewer the office trusts. */
  verdicts?: PrVerdict[];
}

/** Read-only snapshot of the office's world, taken after the event happened. */
export interface WorkflowState {
  ticketForPr(pr: PrRef): string | undefined;

  /** Canonical status of the ticket. */
  ticketStatus(ticket: string): CanonicalStatus | undefined;

  /** For agents `id` is the person handle. */
  assignee(ticket: string): { id: string; kind: "human" | "agent" } | undefined;
  pullRequest(pr: PrRef): WorkflowPr | undefined;

  /** Every pull request linked to the ticket, in any state. */
  pullRequestsOf(ticket: string): WorkflowPr[];

  /** True while the agent's latest work on the ticket ended as a hand-back as done. */
  handedBack(ticket: string): boolean;

  /** Handle of the agent who last worked on the ticket. */
  lastWorker(ticket: string): string | undefined;

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
}

/**
 * What a condition reads of an event: its subject, actor and data. The type is not read, so the office's event
 * pipeline can check conditions on event types of its own (`agent.idle`, the merge-derived events).
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
  | { ticket_handed_back: boolean };

export type HandBackStatus = (typeof HAND_BACK_STATUSES)[number];

export interface StaticTicket {
  status: CanonicalStatus;
  assignee?: { id: string; kind: "human" | "agent" };
  lastWorker?: string;
  requester?: string;
  labels?: string[];

  /** The agent's latest work on the ticket ended as a hand-back as done. */
  handedBack?: boolean;
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
