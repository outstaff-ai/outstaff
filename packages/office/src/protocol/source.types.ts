import type {
  QueuedAct,
  QueuedReport,
  AnswerState,
  Attached,
  Filed,
  Human,
  Link,
  Member,
  PayloadOf,
  SessionUsageReport,
  TicketUsage,
  WorkState,
  WorkSummary,
} from "@outstaff/protocol";

export type Offer = PayloadOf<"offer">;

/** A ticket a chat session filed for someone else: the ticket, the request it files, and who it is for. */
export type FiledFor = Omit<PayloadOf<"work_file_for">, "workItemId">;

/** What an accepted item runs on, as the agent reports it. */
export type RunOn = Omit<PayloadOf<"accept">, "workItemId">;

/**
 * What the protocol server needs from the scheduler and store. The server keeps no state that must survive a
 * restart: which items were offered and accepted lives behind this interface. Every call is scoped to the person
 * whose connection made it; an item of someone else is `unknown_item`.
 */
export interface WorkSource {
  /** Items handed to the person and not finished yet, with whether the agent accepted them. */
  outstanding(person: string): Promise<{ offer: Offer; accepted: boolean }[]>;

  /** Takes the next queued item for the person, or nothing when they are busy or the queue is empty. */
  next(person: string): Promise<Offer | undefined>;

  /** Idempotent. Records the runtime and model the agent says it runs the item on, on the item's run. */
  accept(person: string, workItemId: string, on: RunOn): Promise<void>;

  /**
   * Puts an offered item back in the queue, untouched: no failure is counted, and the journal and stored session
   * stay. Also used for an accepted, unfinished item after the agent restarted.
   */
  decline(person: string, workItemId: string, reason: string): Promise<void>;
  heartbeat(person: string, workItemId: string | undefined): Promise<void>;
  progress(person: string, workItemId: string, text: string): Promise<void>;

  /**
   * Stores the runtime session of the item; the offer of a later round carries it. `model` is the concrete model
   * the runtime reported, recorded on the item's run.
   */
  setSession(person: string, workItemId: string, sessionId: string, model?: string): Promise<void>;
  journal(person: string, workItemId: string, text: string): Promise<void>;
  handBack(
    person: string,
    workItemId: string,
    result: {
      summary: string;
      links: Link[];
      status: "done" | "waiting" | "blocked" | "silent" | "interrupted";

      /** For a done hand-back: what there is to review or what finished, as the agent's check found it. */
      toReview?: string[] | undefined;

      /** What the round used, per runtime session, recorded on its run. */
      usage?: SessionUsageReport[] | undefined;
    },
  ): Promise<void>;

  /** Counts a failed run: the item is held back with backoff, and blocked after repeated failures. */
  fail(
    person: string,
    workItemId: string,
    reason: string,
    usage?: SessionUsageReport[],
  ): Promise<void>;

  roster(): Promise<Member[]>;
  list(person: string, q: { workItemId?: string }): Promise<WorkSummary[]>;

  /**
   * The state of each item, in the order asked, as the person may see it: an item of someone else is `not_yours`
   * whatever its status, and one the office does not have is `unknown`. Never an error for either.
   */
  status(person: string, workItemIds: string[]): Promise<WorkState[]>;
  move(
    person: string,
    workItemId: string,
    status: "queued" | "blocked" | "canceled",
  ): Promise<WorkSummary>;

  /** Puts one of the person's queued items at a place in their queue. */
  place(
    person: string,
    workItemId: string,
    position: "next" | "last" | "before" | "after",
    relativeTo?: string,
  ): Promise<WorkSummary>;
}

/** Chat requests of trusted humans, and the report back to them. Optional: without it chat messages are unsupported. */
export interface ChatDesk {
  message(person: string, m: PayloadOf<"chat_message">): Promise<PayloadOf<"chat_message_result">>;
  report(
    person: string,
    workItemId: string,
    kind: PayloadOf<"chat_report">["kind"],
  ): Promise<PayloadOf<"chat_report_result">>;

  /** The person's open tickets and pull requests, as text. */
  currentWork(person: string): Promise<string>;

  /**
   * The reports to requesters the person's agent has not confirmed posting: sent in the `welcome` and pushed while it
   * is connected, until `posted`. The agent posts them as itself; the office never does.
   */
  queued(person: string): Promise<QueuedReport[]>;

  /** The agent confirmed it posted the queued report `id` of the item: the office stops sending it. */
  posted(person: string, workItemId: string, id: string): Promise<void>;

  /**
   * Files the ticket a chat session created as work: a work item for the ticket, in the session's thread. It starts
   * when the person is idle and otherwise waits last until the requester says where it goes.
   */
  linkTicket(person: string, workItemId: string, ticket: string, request: string): Promise<Filed>;

  /**
   * Records the ticket a chat session created for someone else against the session: a `created` ticket ref, and the
   * request counts as filed. No work item is created; the assignment wakes the assignee. Refused like `linkTicket`.
   */
  fileFor(person: string, workItemId: string, filing: FiledFor): Promise<void>;

  /**
   * Refuses, before anything is created in the tracker, a filing the office would refuse afterwards: a caller that is
   * not a chat session, or a request this message already filed. `request` is the title of the work.
   */
  checkFiling(person: string, workItemId: string, request: string): Promise<void>;

  /**
   * Makes a chat session's request part of existing work of the person: a round on its pull request or ticket, or the
   * item already working on it, with the thread moved to that item. Refused for work that is not the person's, work
   * that is merged or done, and a pull request in review unless the requester confirmed.
   */
  attachWork(
    person: string,
    workItemId: string,
    request: { target: string; confirmed: boolean; request?: string },
  ): Promise<Attached>;

  /** Files work that has no tracker: a work item for the request, in the session's thread. Like `linkTicket`. */
  queueWork(
    person: string,
    workItemId: string,
    request: { title: string; body: string },
  ): Promise<Filed>;
}

/**
 * Which ticket a pull request about to be opened would link to, and what that ticket already has; and the team's pull
 * requests as the work state has them. Optional: without it `ticket_prs` and `pr_list` are unsupported.
 */
export interface TicketPrs {
  forDraft(draft: PayloadOf<"ticket_prs">): Promise<PayloadOf<"ticket_prs_result">>;

  /** The pull requests that match, for the caller (`person`); `author: "me"` is the caller. */
  list(person: string, filter: PayloadOf<"pr_list">): Promise<PayloadOf<"pr_list_result">>;
}

/** The logs of checks on the team's repositories, read with the office's credentials. Optional: without it `ci_log` is unsupported. */
/** Answers `ticket_usage`. Optional: without it the request is unsupported. */
export interface TicketUsageDesk {
  /** Refuses (`invalid`) when the team does not track usage. */
  read(ticket: string): Promise<TicketUsage>;
}

export interface CiLogs {
  /** Refuses (`invalid`) a link that is not a check with a log on one of the team's repositories. */
  read(person: string, request: PayloadOf<"ci_log">): Promise<PayloadOf<"ci_log_result">>;
}

/** An agent's own history in what the office stores, searched. Optional: without it `recall` is unsupported. */
export interface Recall {
  /** The person's moments that match, newest first; refuses (`invalid`) a `since` that is not a date. */
  search(person: string, request: PayloadOf<"recall">): Promise<PayloadOf<"recall_result">>;
}

/** What agents made in their work items: tickets they created, pull requests they opened. Optional: without it `work_made` is unsupported. */
export interface WorkMade {
  /** Records it on the person's work item. Refuses (`unknown_item`) an item that is not theirs. */
  made(person: string, made: PayloadOf<"work_made">): Promise<void>;
}

/** Which documents agents wrote for which work. Optional: without it `doc_link` is unsupported. */
export interface DocLinks {
  /**
   * Records that the person wrote the document for `ticket`, else the ticket of the work item (if it has one). Refuses
   * (`invalid`) a ticket the office does not know.
   */
  link(
    person: string,
    workItemId: string,
    doc: PayloadOf<"doc_link">["doc"],
    ticket?: string,
  ): Promise<void>;
}

/** What agents report about their notes. Optional: without it `notes_changed` is unsupported. */
export interface AgentNotesDesk {
  changed(person: string, report: PayloadOf<"notes_changed">): Promise<void>;
}

/** Agent-to-agent questions. Optional until the messaging component exists; without it `ask` is unsupported. */
export interface Messaging {
  ask(
    from: string,
    q: { to: string; question: string; workItemId?: string | undefined },
  ): Promise<AnswerState>;
  answer(from: string, questionId: string, answer: string): Promise<void>;

  /** The team as agents see it, including the trusted humans. Without it the work source's members are shown. */
  roster?(): Promise<{ members: Member[]; humans: Human[] }>;
}

/** The acts the event pipeline decided for agents, which each agent makes as itself (`act`, `act_result`). */
export interface AgentActs {
  /** The person's unanswered acts, for the `welcome`; recorded as delivered. */
  deliver(person: string): Promise<QueuedAct[]>;

  /** The agent's answer to an act: the office stops sending it and records what it did. An unknown id is ignored. */
  result(person: string, result: PayloadOf<"act_result">): Promise<void>;
}
