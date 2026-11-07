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

/** Messages safe to repeat that end an item or answer an act: sent once more on the next connection if unanswered. */
const AGAIN = { again: true };

/**
 * An offer is taken or given back only on the connection it came on: after a reconnect the office has requeued it
 * and offers it again.
 */
const NOW = { now: true };

/** The office's API over a connection's requests; `activeItems` are the items kept alive by a heartbeat. */
export function officeMethods(call: CallFn, ack: AckFn, activeItems: Set<string>): OfficeMethods {
  return {
    async accept(workItemId, on) {
      await ack("accept", { workItemId, ...on }, NOW);
      activeItems.add(workItemId);
    },

    decline: (workItemId, reason) => ack("decline", { workItemId, reason }, NOW),
    progress: (workItemId, text) => ack("progress", { workItemId, text }),
    session: (workItemId, sessionId, model) =>
      ack("session", { workItemId, sessionId, ...(model ? { model } : {}) }),
    journal: (workItemId, text) => ack("journal", { workItemId, text }),
    // Either way the agent no longer runs the item: one the office never heard end is requeued on the next hello.
    async handBack(workItemId, result) {
      const { usage, ...rest } = result;
      const payload = {
        workItemId,
        ...rest,
        links: result.links ?? [],
        ...(usage?.length ? { usage } : {}),
      };

      await ack("handback", payload, AGAIN).finally(() => activeItems.delete(workItemId));
    },

    async fail(workItemId, reason, usage) {
      await ack("fail", { workItemId, reason, ...(usage?.length ? { usage } : {}) }, AGAIN).finally(
        () => activeItems.delete(workItemId),
      );
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
    async chatCursors() {
      return (await call("chat_cursors", {}, "chat_cursors_result")).cursors;
    },
    reportPosted: (workItemId, id) => ack("report_posted", { workItemId, id }),
    actResult: (result) => ack("act_result", result, AGAIN),
    chatReport: (workItemId, kind): Promise<ChatReportResult> =>
      call("chat_report", { workItemId, kind }, "chat_report_result"),
    linkTicket: (workItemId, ticket, request) =>
      call("work_link", { workItemId, ticket, request }, "work_link_result"),
    fileFor: (workItemId, filing) => ack("work_file_for", { workItemId, ...filing }),
    checkFiling: (workItemId, request) => ack("work_check", { workItemId, request }),
    // The agent's line for the chat reply stays with the agent.
    attachWork: (workItemId, { say: _say, ...request }) =>
      call("work_attach", { workItemId, ...request }, "work_attach_result"),
    queueWork: (workItemId, request) =>
      call("work_queue", { workItemId, ...request }, "work_queue_result"),
    async currentWork() {
      return (await call("current_work", {}, "current_work_result")).text;
    },

    ticketPrs: (draft) => call("ticket_prs", draft, "ticket_prs_result"),
    prList: (filter) => call("pr_list", filter, "pr_list_result"),
    docLink: (request) => ack("doc_link", request),
    workMade: (report) => ack("work_made", report),
    notesChanged: (report) => ack("notes_changed", report),
    ciLog: (request) => call("ci_log", request, "ci_log_result"),
    recall: (request) => call("recall", request, "recall_result"),
    ticketUsage: (ticket) => call("ticket_usage", { ticket }, "ticket_usage_result"),

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

    async resolveRole(role) {
      return (await call("resolve_role", { role }, "resolve_role_result")).handle;
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
