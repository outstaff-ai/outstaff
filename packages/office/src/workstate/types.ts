import type {
  CanonicalStatus,
  Logger,
  PrRef,
  TeamConfig,
  Tracker,
  Vcs,
  WorkflowEvent,
  WorkflowState,
} from "@outstaff/core";
import type { Clock } from "../clock.js";
import type { IntakeMeta } from "../intake/index.js";
import type { Store } from "../store/index.js";

export type CiState = "none" | "pending" | "success" | "failure";

export interface TicketRecord {
  key: string;
  title: string;
  url?: string;
  status?: CanonicalStatus;
  assignee?: { id: string; kind: "human" | "agent" };
  labels: string[];

  /** The human waiting on the work: the latest trusted human to assign the ticket or send it back with feedback. */
  requester?: string;

  /** When the requester was recorded; a later human assignment or send-back replaces it. */
  requesterAt?: string;
  updatedAt: string;
}

export interface PrRecord {
  ref: PrRef;
  title: string;
  url?: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
  state: "open" | "closed" | "merged";
  mergeable: "clean" | "conflicting" | "unknown";
  author: { login: string; kind: "human" | "agent" | "bot"; person?: string };
  checks: { name: string; status: "pending" | "success" | "failure" | "neutral" }[];
  ci: CiState;
  unresolvedThreads: number;

  /** State of the latest submitted review, for example "approved" or "changes_requested". */
  review?: string;
  ticket?: string;

  /** Subject ref of the open pull request this one is stacked on. */
  stackedOn?: string;
  updatedAt: string;
}

export interface WorkstateMeta extends Omit<IntakeMeta, "source"> {
  source: IntakeMeta["source"] | "workstate";
}

export type WorkstateHandler = (event: WorkflowEvent, meta: WorkstateMeta) => void | Promise<void>;

export interface WorkstateOptions {
  store: Store;
  ports: { vcs: Vcs; tracker?: Tracker };
  team: TeamConfig;
  clock: Clock;
  logger: Logger;

  /** How often `start()` rescans open pull requests for CI and mergeability changes. Default 60 seconds. */
  refreshIntervalMs?: number;

  /** How long finished tickets and closed pull requests stay in the state. Default 14 days. */
  retentionMs?: number;
}

export interface CurrentWork {
  person: string;
  tickets: {
    key: string;
    title: string;
    status?: CanonicalStatus;
    prs: string[];
  }[];
  prs: {
    ref: string;
    number: number;
    title: string;
    url?: string;
    state: PrRecord["state"];
    draft: boolean;
    ci: CiState;
    mergeable: PrRecord["mergeable"];
    unresolvedThreads: number;
    review?: string;
    ticket?: string;
    stackedOn?: string;
  }[];
}

export interface WorkState extends WorkflowState {
  /** Idempotent; register as an intake handler. */
  apply(event: WorkflowEvent, meta: IntakeMeta | WorkstateMeta): Promise<void>;

  /** Receives the synthetic events (`pr.conflicted`, `pr.ci_failed`) the work state derives. */
  onEvent(handler: WorkstateHandler): void;

  /** Re-reads every open pull request and live ticket through the ports; losing the store only costs this. */
  rescan(): Promise<void>;

  /** Re-reads who last worked on each ticket from the work item history. */
  refreshWorkers(): Promise<void>;
  currentWork(person: string): CurrentWork;

  /** Rescans on the clock every `refreshIntervalMs`, because CI results arrive without an event. */
  start(): Promise<void>;
  stop(): Promise<void>;

  /** Subject ref of a pull request in the store (also what work items use as `subject.ref`). */
  prSubject(pr: PrRef): string;
}
