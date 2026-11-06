import type { Logger, WorkflowEvent } from "@outstaff/core";
import { itemEventSubject } from "./office-item-subject.js";
import type { Store, WorkItem } from "./store/types.js";
import type { WorkState } from "./workstate/index.js";
import { ROUND_START } from "./round-start.js";
import { readOrigin } from "./chat/origin.js";

/**
 * Keeps the ticket as the round finds it, before its start moves or assigns it: a round that finishes silently puts
 * back what its start changed (`hand_back_silent_restores`).
 */
async function recordRoundStart(
  store: Pick<Store, "upsertSubject">,
  workState: Pick<WorkState, "ticket">,
  item: WorkItem,
  ticket: string,
) {
  const record = workState.ticket(ticket);
  const assignee = record?.assignee;
  await store.upsertSubject(ROUND_START, item.id, {
    ticket,
    ...(record?.status ? { status: record.status } : {}),
    // Whom to give the ticket back to, as an act names them.
    ...(assignee ? { assignee: { id: assignee.id, kind: assignee.kind } } : {}),
  });
}

/**
 * What follows an agent accepting an item: an `agent.started` event for its ticket, or its pull request with a ticket.
 * Nothing for an item with no ticket behind it, such as a chat session or a document's comments. Never throws: the
 * agent's work starts whatever the bookkeeping does.
 */
export function createStarted(deps: {
  store: Store;
  workState: WorkState;

  /** Has the event judged by the pipeline. */
  judge: (event: WorkflowEvent, meta: { source: string; externalId: string }) => Promise<unknown>;
  log: Logger;
}) {
  const { store, workState, judge, log } = deps;
  return async (item: WorkItem): Promise<void> => {
    try {
      const subject = item.subject && (await itemEventSubject(store, item.subject));
      if (!subject?.ticket) {
        return;
      }

      // The policies read the ticket from the state, which may be behind a change made since the tracker was last
      // polled, such as the hand-back of the round before.
      await workState.refreshTicket(subject.ticket).catch((error: unknown) => {
        log.warn("refreshing the ticket before a start failed", { error: String(error) });
      });

      await recordRoundStart(store, workState, item, subject.ticket);
      const runs = await store.listRuns(item.id);
      const event: WorkflowEvent = {
        type: "agent.started",
        subject,
        actor: { kind: "agent", id: item.person },
        // Work a human asked for in chat (a session, or work it filed or attached) starts even on a backlog ticket.
        data: {
          workItem: item.id,
          kind: item.kind,
          ...((await readOrigin(store, item.id)) ? { fromChat: true } : {}),
        },
      };

      await judge(event, {
        source: "workstate",
        externalId: `started:${item.id}:${runs.at(-1)?.id ?? "0"}`,
      });
    } catch (error) {
      log.warn("judging the start of an item failed", { item: item.id, error: String(error) });
    }
  };
}
