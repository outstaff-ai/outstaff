import type {
  Issue,
  Logger,
  PrRef,
  PrVerdict,
  RepoRef,
  TeamConfig,
  Tracker,
  Vcs,
  WorkflowEvent,
} from "@outstaff/core";
import type { Store } from "#/store/index.js";
import type { Clock } from "#/types.js";
import type { DocRecord, PrRecord, TicketRecord, WorkstateHandler } from "./types.js";

/** A person's work items on one ticket: whether one is still open, and when the latest was created. */
export interface Pickup {
  /** An item is queued, running, waiting or blocked. */
  open: boolean;

  /** When the latest item was created (ISO-8601). */
  at: string;
}

/** A synthetic event the work state recorded and still has to deliver. */
export interface Fresh {
  event: WorkflowEvent;
  externalId: string;
}

/** What one apply, rescan or catch-up raised. */
export interface RefreshCtx {
  fresh: Fresh[];
}

/** The work state's configuration and in-memory records, shared by its parts. */
export interface WorkstateCore {
  store: Store;
  vcs: Vcs;
  tracker: Tracker | undefined;
  team: TeamConfig;
  clock: Clock;
  logger: Logger;
  retentionMs: number;
  repos: RepoRef[];

  /** Agent handles by code host login (lower case). */
  vcsPeople: Map<string, string>;

  /** Agent handles by tracker identity. */
  trackerPeople: Map<string, string>;
  prs: Map<string, PrRecord>;
  tickets: Map<string, TicketRecord>;
  docs: Map<string, DocRecord>;

  /** Who last worked on each ticket. */
  workers: Map<string, string>;

  /** Tickets whose latest work item ended as a hand-back as done. */
  handedBack: Set<string>;

  /** Each person's work on each ticket, by `pickupKey`. */
  pickups: Map<string, Pickup>;

  /** Keys that looked like tickets but that the tracker does not know. */
  notTickets: Set<string>;
  handlers: WorkstateHandler[];
  sameRepo(a: RepoRef, b: RepoRef): boolean;
  prSubject(pr: PrRef): string;

  /** The `ticket_link` patterns of the repository, or of every repository without one. */
  ticketLinks(repo?: RepoRef): string[];
}

export interface TicketOps {
  saveTicket(rec: TicketRecord): Promise<void>;

  /** A changed status counts from when the event says the change happened, else the ticket's last update. */
  toTicket(issue: Issue, prev?: TicketRecord, event?: WorkflowEvent): TicketRecord;
  refreshTicket(key: string, event?: WorkflowEvent): Promise<void>;

  /** Whether the key is a ticket the tracker has, reading it once if it is not known yet. */
  ensureTicket(key: string): Promise<boolean>;

  /** The latest trusted human wins; events are ordered by when they happened, never by id. */
  withRequester(rec: TicketRecord, requester: string, event: WorkflowEvent): TicketRecord;
}

/** What is read from the code host about an open pull request beside the pull request itself. */
export interface PrLive {
  checks: PrRecord["checks"];

  /** Each check's link and summary, by check name; only failure events carry them. */
  links: Map<string, { url: string; summary?: string }>;
  unresolved: number;
}

/** What a pull request record is built from beside the pull request and the previous record. */
export interface PrFacts {
  checks: PrRecord["checks"];
  unresolved: number;
  person: string | undefined;
  ticket: string | undefined;
  review: string | undefined;
  verdict: PrVerdict | undefined;
}

/** How a pull request is refreshed. */
export interface RefreshPrOptions {
  /** A pull request seen for the first time sets the baseline instead of raising events. */
  baseline?: boolean;

  /** Wait for the code host to work out mergeability. */
  wait?: boolean;

  review?: string;
  verdict?: PrVerdict;
}

export interface PrOps {
  /** Reads the pull request again; one outside the team's repositories is left alone. */
  refreshPr(ctx: RefreshCtx, ref: PrRef, o?: RefreshPrOptions): Promise<void>;
  ticketOfDraft(
    draft: { headRef: string; title: string; body?: string },
    prev?: PrRecord,
    repo?: RepoRef,
  ): Promise<string | undefined>;

  /** Raises `pr.base_merged` for an open pull request that was stacked on the branch of the merged one. */
  raiseBaseMerged(ctx: RefreshCtx, rec: PrRecord, merged: PrRecord): Promise<void>;
}

export interface RequesterOps {
  recordFeedbackRequester(event: WorkflowEvent, ref: PrRef): Promise<void>;
  recordCommentRequester(key: string, event: WorkflowEvent): Promise<void>;
}

export interface DocOps {
  saveDoc(rec: DocRecord): Promise<void>;
  touchDoc(id: string, event: WorkflowEvent): Promise<void>;
}
