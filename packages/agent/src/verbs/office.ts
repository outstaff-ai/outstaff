import type { Attached, Filed } from "@outstaff/protocol";
import type {
  OfficeWorkItem,
  OfficeTeamMember,
  ChatMessageRequest,
  ChatMessageResult,
  ChatReportKind,
  ChatReportResult,
  TicketPrsRequest,
  TicketPrsResult,
  DocLinkRequest,
  FakeOffice,
} from "./office.types.js";

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
  const checked: FakeOffice["checked"] = [];
  const queued: FakeOffice["queued"] = [];
  const attached: FakeOffice["attached"] = [];
  const chatMessages: ChatMessageRequest[] = [];
  const chatReports: FakeOffice["chatReports"] = [];
  const reportsPosted: FakeOffice["reportsPosted"] = [];
  const ticketPrsAsked: TicketPrsRequest[] = [];
  const docsLinked: DocLinkRequest[] = [];
  const seen = new Set<string>();
  return {
    ticketPrsAsked,
    docsLinked,
    async docLink(request) {
      docsLinked.push(request);
    },
    async ticketPrs(draft) {
      ticketPrsAsked.push(draft);
      return opts.ticketPrs?.(draft) ?? { prs: [] };
    },
    asked,
    answered,
    placed,
    linked,
    checked,
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
    async checkFiling(workItemId, request) {
      checked.push({ workItemId, request });
    },
    async linkTicket(workItemId, ticket, request) {
      linked.push({ workItemId, ticket, request });
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
    reportsPosted,
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
    async reportPosted(workItemId, id) {
      reportsPosted.push({ workItemId, id });
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
