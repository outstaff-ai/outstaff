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
import type { Store } from "../store/index.js";
import type { Clock } from "../types.js";
import type { DocRecord, PrRecord, TicketRecord, WorkstateHandler } from "./types.js";

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
  toTicket(issue: Issue, prev?: TicketRecord): TicketRecord;
  refreshTicket(key: string, event?: WorkflowEvent): Promise<void>;

  /** Whether the key is a ticket the tracker has, reading it once if it is not known yet. */
  ensureTicket(key: string): Promise<boolean>;

  /** The latest trusted human wins; events are ordered by when they happened, never by id. */
  withRequester(rec: TicketRecord, requester: string, event: WorkflowEvent): TicketRecord;
}

export interface PrOps {
  refreshPr(
    ctx: RefreshCtx,
    ref: PrRef,
    o?: { baseline?: boolean; wait?: boolean; review?: string; verdict?: PrVerdict },
  ): Promise<void>;
  ticketOfDraft(
    draft: { headRef: string; title: string; body?: string },
    prev?: PrRecord,
    repo?: RepoRef,
  ): Promise<string | undefined>;
}

export interface RequesterOps {
  recordFeedbackRequester(event: WorkflowEvent, ref: PrRef): Promise<void>;
  recordCommentRequester(key: string, event: WorkflowEvent): Promise<void>;
}

export interface DocOps {
  saveDoc(rec: DocRecord): Promise<void>;
  touchDoc(id: string, event: WorkflowEvent): Promise<void>;
}
