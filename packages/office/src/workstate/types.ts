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

  /** The tickets this one blocks, as the tracker last said. */
  blocks?: string[];

  /** The tickets that block this one, with their status as the tracker last said. */
  blockedBy?: { key: string; status?: CanonicalStatus }[];

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
/** A document an agent recorded: `author` is that agent, `ticket` the ticket it is for, when any. */
export interface DocLink {
  id: string;
  title: string;
  url: string;
  author: string;
  ticket?: string | undefined;
}

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

/** A check on a merge commit that did not pass, as a `pr.merge_checks_failed` names it. */
export interface MergeCheck {
  name: string;
  url?: string;

  /** Set when the code host can show the check's log (`Vcs.checkLog`). */
  logId?: string;
}

/** The checks on the commit a merge made on the default branch, followed from the merge until they are decided. */
export interface MergeChecks {
  /** The merge commit; absent when the code host does not say, which counts as passed. */
  sha?: string;

  /** When the office saw the merge (ISO-8601); the waits count from here. */
  since: string;
  state: "pending" | "passed" | "failed";

  /** For a failed merge: the checks that failed, or the ones still running at the timeout. */
  failing?: MergeCheck[];

  /** The merge failed because a check was still running after `policies.merge_checks.timeout_minutes`. */
  timedOut?: boolean;

  /**
   * Since when every check seen has finished without failing, and which they were. The merge passes once no new check
   * appears for `policies.merge_checks.settle_minutes`; a check that starts ends the quiet.
   */
  quiet?: { since: string; checks: string[] };
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

  /** For a pull request merged into the default branch: the checks on its merge commit. */
  mergeChecks?: MergeChecks;

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

  /** How often `start()` reads the checks of merges not decided yet. Default `office.poll_interval_seconds`. */
  followIntervalMs?: number;

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

  /**
   * Receives the synthetic events the work state derives: `pr.conflicted`, `pr.ci_failed`, `pr.ci_passed`,
   * `pr.base_merged`, `pr.linked`, `pr.merge_checks_passed`, `pr.merge_checks_failed`, `ticket.closed` and
   * `ticket.unblocked`.
   */
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

  /**
   * Re-reads one ticket from the tracker, for a ticket an agent may have changed since the last poll. `by` is who
   * changed it, when known: if the ticket turns out closed now, the tickets it unblocked name them.
   */
  refreshTicket(key: string, by?: WorkflowEvent["actor"]): Promise<void>;
  currentWork(person: string): CurrentWork;

  /**
   * The tickets the agent could start next: assigned to it, in the ready status, and not worked on by it since they
   * entered ready (no item of its on the ticket is queued, running, waiting or blocked, and none started after). As of
   * the last `refreshWorkers`.
   */
  readyTickets(person: string): ReadyTicket[];

  /**
   * Reads the checks on the merge commit of each merge not decided yet, and raises `pr.merge_checks_passed` or
   * `pr.merge_checks_failed` once for each merge they decide.
   */
  followMerges(): Promise<void>;

  /**
   * Rescans on the clock every `refreshIntervalMs`, because CI results arrive without an event, and follows merges
   * every `followIntervalMs`.
   */
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

  /**
   * Records that an agent wrote a document, for a ticket or not. Idempotent; the first author stays. A ticket the
   * document is for now, and was not before, raises `doc.linked`.
   */
  linkDoc(doc: DocLink): Promise<void>;
  doc(id: string): DocRecord | undefined;

  /** The documents whose comments are worth reading: those of tickets not finished, and recent ones without. Most recently active first. */
  openDocs(limit: number): DocRecord[];
}

/** What linked a pull request to a ticket. */
export type TicketSource = "branch" | "title" | "closing keyword" | "ticket_link";

export type TicketCandidate = { key: string; source: TicketSource };
