import type { WorkState } from "@outstaff/protocol";
import type {
  ChatMessageResult,
  ChatReportResult,
  OfficeAnswer,
  OfficeTeam,
  OfficeTeamMember,
  OfficeWorkItem,
} from "#/verbs/office.types.js";
import type { AckFn, CallFn, OfficeMethods } from "./types.js";

/** Drops keys that are undefined, which the verbs' types do not allow for optional fields. */
const compact = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** The office's API over a connection's requests; `activeItems` are the items kept alive by a heartbeat. */
export function officeMethods(call: CallFn, ack: AckFn, activeItems: Set<string>): OfficeMethods {
  return {
    async accept(workItemId) {
      await ack("accept", { workItemId });
      activeItems.add(workItemId);
    },

    decline: (workItemId, reason) => ack("decline", { workItemId, reason }),
    progress: (workItemId, text) => ack("progress", { workItemId, text }),
    session: (workItemId, sessionId) => ack("session", { workItemId, sessionId }),
    journal: (workItemId, text) => ack("journal", { workItemId, text }),
    async handBack(workItemId, result) {
      await ack("handback", { workItemId, ...result, links: result.links ?? [] });
      activeItems.delete(workItemId);
    },

    async fail(workItemId, reason) {
      await ack("fail", { workItemId, reason });
      activeItems.delete(workItemId);
    },

    usage: (windows) => ack("usage", { windows }),
    doctorReport: (checks) => ack("doctor_report", { checks }),
    answer: (questionId, answer) => ack("answer", { questionId, answer }),

    async place(workItemId, placement) {
      const r = await call(
        "work_place",
        {
          workItemId,
          position: placement.position,
          ...(placement.relativeTo ? { relativeTo: placement.relativeTo } : {}),
        },
        "work_move_result",
      );

      return compact(r.item) as OfficeWorkItem;
    },

    chatMessage: (m): Promise<ChatMessageResult> => call("chat_message", m, "chat_message_result"),
    reportPosted: (workItemId, id) => ack("report_posted", { workItemId, id }),
    chatReport: (workItemId, kind): Promise<ChatReportResult> =>
      call("chat_report", { workItemId, kind }, "chat_report_result"),
    linkTicket: (workItemId, ticket, request) =>
      call("work_link", { workItemId, ticket, request }, "work_link_result"),
    checkFiling: (workItemId, request) => ack("work_check", { workItemId, request }),
    attachWork: (workItemId, request) =>
      call("work_attach", { workItemId, ...request }, "work_attach_result"),
    queueWork: (workItemId, request) =>
      call("work_queue", { workItemId, ...request }, "work_queue_result"),
    async currentWork() {
      return (await call("current_work", {}, "current_work_result")).text;
    },

    ticketPrs: (draft) => call("ticket_prs", draft, "ticket_prs_result"),
    docLink: (request) => ack("doc_link", request),

    async ask(q): Promise<OfficeAnswer> {
      const r = await call("ask", q, "ask_result");
      return {
        id: r.id,
        to: r.to,
        status: r.status,
        ...(r.answer === undefined ? {} : { answer: r.answer }),
      };
    },

    async work(q): Promise<OfficeWorkItem[]> {
      const r = await call("work_list", q, "work_list_result");
      return r.items.map((i) => compact(i) as OfficeWorkItem);
    },

    async workStatus(workItemIds): Promise<WorkState[]> {
      return (await call("work_status", { workItemIds }, "work_status_result")).items;
    },

    async team(): Promise<OfficeTeam> {
      const r = await call("roster", {}, "roster_result");
      return {
        members: r.members.map((m) => compact(m) as OfficeTeamMember),
        humans: r.humans ?? [],
      };
    },
  };
}
