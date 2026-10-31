import type { Attached, Filed, PayloadOf, WorkSummary } from "@outstaff/protocol";

/** What the office tells an agent; the wire protocol is defined separately (the verbs only need this). */
export type OfficeWorkItem = WorkSummary;

export interface OfficeTeamMember {
  handle: string;
  name: string;
  role: string;
  title?: string;
  summary?: string;
  status: "idle" | "working" | "paused" | "offline";
  current?: string;

  /** The busiest recent LLM usage window, when the office knows it. */
  usage?: { window: string; utilization: number; resetsAt?: string };
}

export interface OfficeTeam {
  members: OfficeTeamMember[];

  /** The trusted humans. */
  humans: { name: string }[];
}

export interface OfficeAnswer {
  id: string;
  to: string;
  status: "answered" | "pending";
  answer?: string;
}

export type ChatMessageRequest = PayloadOf<"chat_message">;

export type ChatMessageResult = PayloadOf<"chat_message_result">;

export type ChatReportKind = PayloadOf<"chat_report">["kind"];

export type ChatReportResult = PayloadOf<"chat_report_result">;

export type TicketPrsRequest = PayloadOf<"ticket_prs">;

export type TicketPrsResult = PayloadOf<"ticket_prs_result">;

export type DocLinkRequest = PayloadOf<"doc_link">;

export type Placement = Pick<PayloadOf<"work_place">, "position" | "relativeTo">;

export interface OfficeClient {
  /** Ask a teammate a question; the office routes it and may answer later. */
  ask(q: { to: string; question: string; workItemId?: string }): Promise<OfficeAnswer>;

  /** Answer a question the office routed to the caller. */
  answer(questionId: string, answer: string): Promise<void>;

  /** The caller's work items. */
  work(q: { workItemId?: string }): Promise<OfficeWorkItem[]>;
  team(): Promise<OfficeTeam>;

  /** Puts one of the caller's queued items at a place in the queue. */
  place(workItemId: string, placement: Placement): Promise<OfficeWorkItem>;

  /** A trusted human's chat message: the office decides what becomes of it. */
  chatMessage(m: ChatMessageRequest): Promise<ChatMessageResult>;

  /** Asks to tell the requester of a chat item how it ended; false in `post` when that was done already. */
  chatReport(workItemId: string, kind: ChatReportKind): Promise<ChatReportResult>;

  /** Confirms a queued report was posted; the office sends it again until then. */
  reportPosted(workItemId: string, id: string): Promise<void>;

  /** The caller's open tickets and pull requests, as text. */
  currentWork(): Promise<string>;

  /** The ticket a pull request about to be opened would link to, and the pull requests that ticket already has. */
  ticketPrs(draft: TicketPrsRequest): Promise<TicketPrsResult>;

  /**
   * Tells the office the caller wrote a document for the work item's ticket, so that comments people leave on it
   * come back as work for the caller.
   */
  docLink(request: DocLinkRequest): Promise<void>;

  /** Files the ticket a chat session created as work. Refused for anything but a chat session, and for filing the same request twice. */
  linkTicket(workItemId: string, ticket: string, request: string): Promise<Filed>;

  /**
   * Records a ticket a chat session created for someone else against the session: no work item for the caller, and
   * the assignment wakes the assignee. Refused like `linkTicket`.
   */
  fileFor(
    workItemId: string,
    filing: { ticket: string; request: string; assignee: string },
  ): Promise<void>;

  /** Asks whether a chat session may file this request, before anything is created. Refused when it may not. */
  checkFiling(workItemId: string, request: string): Promise<void>;

  /** Makes a chat session's request part of the caller's existing ticket or pull request. */
  attachWork(
    workItemId: string,
    request: { target: string; confirmed: boolean; request?: string },
  ): Promise<Attached>;

  /** Files work from a chat session when there is no tracker. Like `linkTicket`. */
  queueWork(workItemId: string, request: { title: string; body: string }): Promise<Filed>;
}

export interface FakeOffice extends OfficeClient {
  asked: { to: string; question: string; workItemId?: string }[];
  answered: { questionId: string; answer: string }[];
  placed: { workItemId: string; placement: Placement }[];
  linked: { workItemId: string; ticket: string; request: string }[];
  filedFor: { workItemId: string; ticket: string; request: string; assignee: string }[];
  checked: { workItemId: string; request: string }[];
  queued: { workItemId: string; title: string; body: string }[];
  attached: { workItemId: string; target: string; confirmed: boolean; request?: string }[];
  chatMessages: ChatMessageRequest[];
  chatReports: { workItemId: string; kind: ChatReportKind }[];
  reportsPosted: { workItemId: string; id: string }[];
  ticketPrsAsked: TicketPrsRequest[];
  docsLinked: DocLinkRequest[];
}

export type { Attached, Filed } from "@outstaff/protocol";
