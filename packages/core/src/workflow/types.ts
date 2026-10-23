import type { RepoRef } from "../ports/repo.js";
import type { CanonicalStatus } from "../ports/status.js";

export const WORKFLOW_EVENT_TYPES = [
  "pr.opened",
  "pr.merged",
  "pr.closed",
  "pr.review_submitted",
  "pr.comment",
  "pr.conflicted",
  "pr.ci_failed",
  "ticket.assigned",
  "ticket.moved",
  "ticket.commented",
  "ticket.created",
  "agent.handed_back",
  "agent.asked",
  "schedule.cron",
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export type ActorKind = "human" | "agent" | "automation";

export interface PrRef {
  repo: RepoRef;
  number: number;
}

/** A normalized event. The office maps tracker, VCS and agent events onto this shape. */
export interface WorkflowEvent {
  type: WorkflowEventType;
  subject: { ticket?: string; pr?: PrRef };
  actor: { kind: ActorKind; id: string };

  /**
   * Event specific data. `ticket.moved` carries `to` (and `from`) as canonical statuses;
   * `pr.review_submitted` carries `state` (for example "approved" or "changes_requested").
   */
  data: Record<string, unknown>;
}

export interface WorkflowPr {
  ref: PrRef;
  title: string;
  url?: string;
  headRef: string;
  baseRef: string;
  draft: boolean;

  /** `person` is the agent's handle when the author is one of our agents. */
  author: { login: string; kind: "human" | "agent" | "bot"; person?: string };
}

/** Read-only snapshot of the office's world, taken after the event happened. */
export interface WorkflowState {
  ticketForPr(pr: PrRef): string | undefined;

  /** Canonical status of the ticket. */
  ticketStatus(ticket: string): CanonicalStatus | undefined;

  /** For agents `id` is the person handle. */
  assignee(ticket: string): { id: string; kind: "human" | "agent" } | undefined;
  pullRequest(pr: PrRef): WorkflowPr | undefined;

  /** Handle of the agent who last worked on the ticket. */
  lastWorker(ticket: string): string | undefined;

  /** Id of the human who asked for the work. */
  requester(ticket: string): string | undefined;
  hasLabel(ticket: string, label: string): boolean;

  /** Open pull requests whose base is `branch`. */
  stackedOn(repo: RepoRef, branch: string): WorkflowPr[];

  /** Handle of the agent playing a catalog role, if exactly one is configured. */
  personForRole(role: string): string | undefined;
}

export type EffectTarget = { kind: "agent" | "human"; id: string };
export type Priority = "low" | "normal" | "high";

export type Effect =
  | { type: "move"; ticket: string; to: CanonicalStatus }
  | { type: "assign"; ticket: string; to: EffectTarget | null }
  | { type: "comment"; on: { ticket: string } | { pr: PrRef }; template: string; body: string }
  | {
      type: "schedule";
      person: string;
      kind: string;
      priority: Priority;
      ticket?: string;
      pr?: PrRef;
    }
  | {
      type: "notify";
      to: { kind: "human" | "agent" | "channel"; id?: string };
      template: string;
      body: string;
      ticket?: string;
      pr?: PrRef;
    };

export interface WorkflowOptions {
  /** Extra templates by id; they override built-ins with the same id. */
  templates?: Record<string, string>;

  /** Label meaning "leave this to a human". Default `needs-human`. */
  needsHumanLabel?: string;
}

export const DEFAULT_NEEDS_HUMAN_LABEL = "needs-human";
