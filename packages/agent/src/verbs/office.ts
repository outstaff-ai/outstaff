import { PortError } from "@outstaff/core";
import type { Attached, Filed, TicketUsage } from "@outstaff/protocol";
import type {
  OfficeWorkItem,
  OfficeTeamMember,
  ChatCursorEntry,
  ChatMessageRequest,
  ChatMessageResult,
  ChatReportKind,
  ChatReportResult,
  TicketPrsRequest,
  TicketPrsResult,
  PrListRequest,
  PrListResult,
  DocLinkRequest,
  WorkMadeReport,
  NotesReport,
  CiLogRequest,
  CiLogResult,
  RecallRequest,
  RecallResult,
  FakeOffice,
} from "./office.types.js";

const NONE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  tokens: 0,
  costUsd: 0,
  runs: 0,
};

/** A ticket nothing was used on. */
const emptyUsage = (ticket: string): TicketUsage => ({
  ticket,
  own: NONE,
  total: NONE,
  subTickets: [],
  byPerson: [],
  byModel: [],
  byKind: [],
});

export function createFakeOffice(
  opts: {
    items?: OfficeWorkItem[];
    team?: OfficeTeamMember[];
    humans?: { name: string }[];
    answer?: (to: string, question: string) => string | undefined;

    chatReport?: (workItemId: string, kind: ChatReportKind) => ChatReportResult;
    currentWork?: string;

    /** What the office answers about the pull requests of the ticket a draft links to; by default none. */
    ticketPrs?: (draft: TicketPrsRequest) => TicketPrsResult;

    /** What the office answers for a pull request list; by default none. */
    prList?: (filter: PrListRequest) => PrListResult;

    /** What the office answers for a check's log; by default a log with no failed step. */
    ciLog?: (request: CiLogRequest) => CiLogResult;

    /** What the office answers for a recall; by default nothing matches. */
    recall?: (request: RecallRequest) => RecallResult;

    /** What the office answers for a ticket's usage; by default nothing was used. */
    ticketUsage?: (ticket: string) => TicketUsage;

    /** What the office answers when a chat session files work; by default the person is idle. */
    filed?: Partial<Filed>;

    /** What the office answers when a chat session attaches its request; by default it is attached. */
    attach?: (target: string, confirmed: boolean) => Partial<Attached>;
  } = {},
): FakeOffice {
  const asked: FakeOffice["asked"] = [];
  const rolesResolved: string[] = [];
  const answered: FakeOffice["answered"] = [];
  const placed: FakeOffice["placed"] = [];
  const linked: FakeOffice["linked"] = [];
  const filedFor: FakeOffice["filedFor"] = [];
  const checked: FakeOffice["checked"] = [];
  const queued: FakeOffice["queued"] = [];
  const attached: FakeOffice["attached"] = [];
  const chatMessages: ChatMessageRequest[] = [];
  const chatReports: FakeOffice["chatReports"] = [];
  const reportsPosted: FakeOffice["reportsPosted"] = [];
  const ticketPrsAsked: TicketPrsRequest[] = [];
  const prListsAsked: PrListRequest[] = [];
  const docsLinked: DocLinkRequest[] = [];
  const made: WorkMadeReport[] = [];
  const notesReported: NotesReport[] = [];
  const ciLogsAsked: CiLogRequest[] = [];
  const recalled: RecallRequest[] = [];
  const usageAsked: string[] = [];
  const seen = new Set<string>();
  return {
    ticketPrsAsked,
    prListsAsked,
    docsLinked,
    made,
    notesReported,
    ciLogsAsked,
    recalled,
    async recall(request) {
      recalled.push(request);
      return opts.recall?.(request) ?? { moments: [], more: false };
    },
    usageAsked,
    async ticketUsage(ticket) {
      usageAsked.push(ticket);
      return opts.ticketUsage?.(ticket) ?? emptyUsage(ticket);
    },
    async ciLog(request) {
      ciLogsAsked.push(request);
      return opts.ciLog?.(request) ?? { repo: "acme/shop", steps: [] };
    },
    async docLink(request) {
      docsLinked.push(request);
    },
    async workMade(report) {
      made.push(report);
    },
    async notesChanged(report) {
      notesReported.push(report);
    },
    async ticketPrs(draft) {
      ticketPrsAsked.push(draft);
      return opts.ticketPrs?.(draft) ?? { prs: [] };
    },
    async prList(filter) {
      prListsAsked.push(filter);
      return opts.prList?.(filter) ?? { prs: [], more: 0 };
    },
    asked,
    answered,
    placed,
    linked,
    filedFor,
    checked,
    queued,
    attached,
    async attachWork(workItemId, request) {
      attached.push({ workItemId, ...request });
      return {
        item: { id: "work-attached", title: request.target, status: "queued" },
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
    async linkTicket(workItemId, ticket, request, say) {
      linked.push({ workItemId, ticket, request, ...(say ? { say } : {}) });
      return {
        url: `https://tracker.acme.example/issue/${ticket}`,
        item: { id: `work-${ticket}`, title: ticket, status: "queued" },
        work: [],
        ...opts.filed,
      };
    },
    async fileFor(workItemId, filing) {
      filedFor.push({ workItemId, ...filing });
    },
    async queueWork(workItemId, request) {
      queued.push({ workItemId, ...request });
      return {
        item: { id: `work-${queued.length}`, title: request.title, status: "queued" },
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
    async chatMessage(m): Promise<ChatMessageResult> {
      chatMessages.push(m);
      const repeated = seen.has(m.messageId);
      seen.add(m.messageId);
      return { repeated };
    },
    // Like the office: the latest message time of each conversation it took a message in from.
    async chatCursors() {
      const latest = new Map<string, ChatCursorEntry>();
      for (const m of chatMessages) {
        const key = `${m.channel}:${m.thread ?? ""}`;
        if ((latest.get(key)?.at ?? "") < m.at) {
          latest.set(key, {
            channel: m.channel,
            ...(m.thread ? { thread: m.thread } : {}),
            at: m.at,
          });
        }
      }

      return [...latest.values()].toSorted((a, b) => (a.at < b.at ? 1 : -1));
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
    rolesResolved,
    async resolveRole(role) {
      rolesResolved.push(role);
      const to = opts.team?.find((m) => m.role === role);
      if (!to) {
        throw new PortError("not_found", `no ${role} on this team; ask a human`);
      }

      return to.handle;
    },
  };
}
