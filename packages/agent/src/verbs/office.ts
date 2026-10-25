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

export type { Attached, Filed };
export type ChatMessageRequest = PayloadOf<"chat_message">;
export type ChatMessageResult = PayloadOf<"chat_message_result">;
export type ChatReportKind = PayloadOf<"chat_report">["kind"];
export type ChatReportResult = PayloadOf<"chat_report_result">;
export type TicketPrsRequest = PayloadOf<"ticket_prs">;
export type TicketPrsResult = PayloadOf<"ticket_prs_result">;
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

  /** The caller's open tickets and pull requests, as text. */
  currentWork(): Promise<string>;

  /** The ticket a pull request about to be opened would link to, and the pull requests that ticket already has. */
  ticketPrs(draft: TicketPrsRequest): Promise<TicketPrsResult>;

  /** Files the ticket a chat session created as work. Refused for anything but a chat session, and for a second filing. */
  linkTicket(workItemId: string, ticket: string): Promise<Filed>;

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
  linked: { workItemId: string; ticket: string }[];
  queued: { workItemId: string; title: string; body: string }[];
  attached: { workItemId: string; target: string; confirmed: boolean; request?: string }[];
  chatMessages: ChatMessageRequest[];
  chatReports: { workItemId: string; kind: ChatReportKind }[];
  ticketPrsAsked: TicketPrsRequest[];
}

export function createFakeOffice(
  opts: {
    items?: OfficeWorkItem[];
    team?: OfficeTeamMember[];
    humans?: { name: string }[];
    answer?: (to: string, question: string) => string | undefined;

    /** What the office answers a chat message; by default it starts an item. */
    chatMessage?: (m: ChatMessageRequest) => ChatMessageResult;
    chatReport?: (workItemId: string, kind: ChatReportKind) => ChatReportResult;
    currentWork?: string;

    /** What the office answers about the pull requests of the ticket a draft links to; by default none. */
    ticketPrs?: (draft: TicketPrsRequest) => TicketPrsResult;

    /** What the office answers when a chat session files work; by default the person is idle. */
    filed?: Partial<Filed>;

    /** What the office answers when a chat session attaches its request; by default it is attached. */
    attach?: (target: string, confirmed: boolean) => Partial<Attached>;
  } = {},
): FakeOffice {
  const asked: FakeOffice["asked"] = [];
  const answered: FakeOffice["answered"] = [];
  const placed: FakeOffice["placed"] = [];
  const linked: FakeOffice["linked"] = [];
  const queued: FakeOffice["queued"] = [];
  const attached: FakeOffice["attached"] = [];
  const chatMessages: ChatMessageRequest[] = [];
  const chatReports: FakeOffice["chatReports"] = [];
  const ticketPrsAsked: TicketPrsRequest[] = [];
  const seen = new Set<string>();
  return {
    ticketPrsAsked,
    async ticketPrs(draft) {
      ticketPrsAsked.push(draft);
      return opts.ticketPrs?.(draft) ?? { prs: [] };
    },
    asked,
    answered,
    placed,
    linked,
    queued,
    attached,
    async attachWork(workItemId, request) {
      attached.push({ workItemId, ...request });
      return {
        item: { id: "work-attached", title: request.target, status: "queued" },
        waiting: false,
        work: [],
        attached: {
          pr: {
            type: "pr",
            ref: "#11",
            title: "Add search",
            url: "https://git.acme.example/acme/app/pull/11",
          },
          ticket: {
            type: "ticket",
            ref: "SHOP-11",
            url: "https://tracker.acme.example/issue/SHOP-11",
          },
        },
        ...opts.attach?.(request.target, request.confirmed),
      };
    },
    async linkTicket(workItemId, ticket) {
      linked.push({ workItemId, ticket });
      return {
        url: `https://tracker.acme.example/issue/${ticket}`,
        item: { id: `work-${ticket}`, title: ticket, status: "queued" },
        waiting: false,
        work: [],
        ...opts.filed,
      };
    },
    async queueWork(workItemId, request) {
      queued.push({ workItemId, ...request });
      return {
        item: { id: `work-${queued.length}`, title: request.title, status: "queued" },
        waiting: false,
        work: [],
        ...opts.filed,
      };
    },
    chatMessages,
    chatReports,
    async place(workItemId, placement) {
      placed.push({ workItemId, placement });
      return { id: workItemId, title: workItemId, status: "queued" };
    },
    async chatMessage(m) {
      chatMessages.push(m);
      const repeated = seen.has(m.messageId);
      seen.add(m.messageId);
      const result = opts.chatMessage?.(m) ?? {
        disposition: "started" as const,
        repeated: false,
        item: { id: `chat-${chatMessages.length}`, title: m.text, status: "queued" },
        links: [],
        work: [],
      };

      return { ...result, repeated };
    },
    async chatReport(workItemId, kind) {
      chatReports.push({ workItemId, kind });
      return opts.chatReport?.(workItemId, kind) ?? { post: true, requester: "U-req", links: [] };
    },
    async currentWork() {
      return opts.currentWork ?? "No open tickets or pull requests.";
    },
    async answer(questionId, answer) {
      answered.push({ questionId, answer });
    },
    async ask(q) {
      asked.push(q);
      const answer = opts.answer?.(q.to, q.question);
      return {
        id: `q-${asked.length}`,
        to: q.to,
        status: answer === undefined ? "pending" : "answered",
        ...(answer === undefined ? {} : { answer }),
      };
    },
    async work(q) {
      const items = opts.items ?? [];
      return items.map((i) => ({ ...i, current: i.id === q.workItemId }));
    },
    async team() {
      return { members: opts.team ?? [], humans: opts.humans ?? [] };
    },
  };
}
