import { formatCurrentWork } from "#/workstate/index.js";
import { createAttach } from "./desk-attach.js";
import { createFiling } from "./desk-filing.js";
import { createReports } from "./desk-reports.js";
import type { ChatDeskOptions, ChatRequests } from "./desk.types.js";

/**
 * The office's side of the chat verbs an agent's chat session calls (filing a ticket or a request as work, attaching
 * a request to existing work) and of the reports the agent owes requesters. Messages themselves are events, which the
 * pipeline decides on.
 */
export function createChatDesk(opts: ChatDeskOptions): ChatRequests {
  const { store } = opts;
  const filing = createFiling(opts);
  return {
    ...createReports(opts),
    attachWork: createAttach(opts, filing),

    async checkFiling(person, workItemId, request) {
      await filing.sessionOf(person, workItemId, request);
    },

    async linkTicket(person, workItemId, ticket, request) {
      const title = (await store.getSubject("ticket", ticket))?.data as
        | { title?: string }
        | undefined;

      const filed = await filing.file(person, workItemId, {
        kind: "assigned",
        title: `assigned: ${ticket}${title?.title ? ` ${title.title}` : ""}`,
        request,
        subject: { type: "ticket", ref: ticket },
        note: `Tracked in ${ticket}.`,
        source: "work_link",
      });

      const url = opts.tracker?.links.issue(ticket);
      await store.addItemRefs(workItemId, [
        { type: "ticket", ref: ticket, url, role: "created", source: "work_link" },
      ]);

      return { ...filed, ...(url ? { url } : {}) };
    },

    queueWork(person, workItemId, request) {
      return filing.file(person, workItemId, {
        kind: "request",
        title: request.title,
        request: request.title,
        subject: { type: "chat", ref: workItemId },
        note: request.body,
        source: "work_queue",
      });
    },

    async currentWork(person) {
      return formatCurrentWork(opts.workState.currentWork(person));
    },
  };
}
