import type {
  CanonicalStatus,
  Logger,
  PrRef,
  PrVerdict,
  RepoRef,
  TeamConfig,
  Tracker,
  Vcs,
  WorkflowEvent,
  WorkflowState,
} from "@outstaff/core";
import type { Clock } from "#/types.js";
import type { IntakeMeta } from "#/intake/index.js";
import type { Store } from "#/store/index.js";

export type CiState = "none" | "pending" | "success" | "failure";

export interface TicketRecord {
  key: string;
  title: string;
  url?: string;
  status?: CanonicalStatus;

  /** When the ticket entered its current status (ISO-8601), from the tracker's event or its last update. */
  statusSince?: string;

  /** The tracker's priority, when its adapter has one: 1 is the most urgent. */
  priority?: number;
  assignee?: { id: string; kind: "human" | "agent" };
  labels: string[];

  /** The human waiting on the work: the latest trusted human to assign the ticket or send it back with feedback. */
  requester?: string;

  /** When the requester was recorded; a later human assignment or send-back replaces it. */
  requesterAt?: string;

  /** When the tracker answered that the ticket does not exist. It is not refreshed again unless an event names it. */
  goneAt?: string;
  updatedAt: string;
}

/** A ready ticket assigned to an agent, with when it entered ready. */
export interface ReadyTicket {
  key: string;
  title?: string | undefined;

  /** When the ticket entered ready (ISO-8601). */
  readyAt: string;

  /** The tracker's priority, when it has one: 1 is the most urgent. */
  priority?: number | undefined;
}

/** A knowledge document an agent wrote for a ticket (or in a chat request), kept so comments on it reach the agent. */
export interface DocRecord {
  id: string;
  title: string;
  url: string;

  /** Handle of the agent who wrote it. */
  author: string;

  /** The ticket the work item that wrote it was about, if any. */
  ticket?: string;

  /** When the document was linked or last commented on; the most recently active are read first. */
  touchedAt: string;
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

  /** Latest decisive review of each reviewer the office trusts (not of untrusted people). */
  verdicts?: PrVerdict[];
  ticket?: string;

  /** Subject ref of the open pull request this one is stacked on. */
  stackedOn?: string;

  /**
   * When the code host answered that the pull request is not there or not ours to read (not found or forbidden). It is
   * not refreshed again until an event names it or the host lists it again.
   */
  goneAt?: string;
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

  /** Receives the synthetic events (`pr.conflicted`, `pr.ci_failed`, `pr.ci_passed`, `pr.base_merged`, `pr.linked`) the work state derives. */
  onEvent(handler: WorkstateHandler): void;

  /** Re-reads every open pull request and live ticket through the ports; losing the store only costs this. */
  rescan(): Promise<void>;

  /**
   * Takes in the open pull requests the state has not heard of yet, for example one opened a moment ago whose event
   * has not arrived. Raises no events: the ones that do arrive still do their work.
   */
  catchUp(): Promise<void>;

  /** Re-reads who last worked on each ticket from the work item history. */
  refreshWorkers(): Promise<void>;

  /** Re-reads one ticket from the tracker, for a ticket an agent may have changed since the last poll. */
  refreshTicket(key: string): Promise<void>;
  currentWork(person: string): CurrentWork;

  /**
   * The tickets the agent could start next: assigned to it, in the ready status, and not worked on by it since they
   * entered ready (no item of its on the ticket is queued, running, waiting or blocked, and none started after). As of
   * the last `refreshWorkers`.
   */
  readyTickets(person: string): ReadyTicket[];

  /** Rescans on the clock every `refreshIntervalMs`, because CI results arrive without an event. */
  start(): Promise<void>;
  stop(): Promise<void>;

  /** Subject ref of a pull request in the store (also what work items use as `subject.ref`). */
  prSubject(pr: PrRef): string;

  /** The pull requests with this number, in any state, from every repository; never a gone one. */
  pullRequests(number: number): PrRecord[];

  /** The pull requests of a repository the state keeps, in any state: open ones, and recently finished ones; never a gone one. */
  repoPrs(repo: RepoRef): PrRecord[];

  /** The pull requests linked to the ticket, in any state; never a gone one. */
  prsOfTicket(ticket: string): PrRecord[];

  /** The ticket a pull request about to be opened would link to, by the rule that links the ones that exist. */
  ticketForDraft(draft: {
    headRef: string;
    title: string;
    body?: string;
  }): Promise<string | undefined>;
  ticket(key: string): TicketRecord | undefined;

  /** Records that an agent wrote a document, for a ticket or not. Idempotent; the first author stays. */
  linkDoc(doc: {
    id: string;
    title: string;
    url: string;
    author: string;
    ticket?: string;
  }): Promise<void>;
  doc(id: string): DocRecord | undefined;

  /** The documents whose comments are worth reading: those of tickets not finished, and recent ones without. Most recently active first. */
  openDocs(limit: number): DocRecord[];
}

/** What linked a pull request to a ticket. */
export type TicketSource = "branch" | "title" | "closing keyword" | "ticket_link";

export type TicketCandidate = { key: string; source: TicketSource };
