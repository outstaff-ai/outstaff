import type { Logger, WorkflowEvent } from "@outstaff/core";
import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord, WorkState } from "./workstate/index.js";

const handedBackText = (item: WorkItem) => `handed back ${item.id}`;

const HANDED_BACK = new Set(["done", "waiting", "blocked"]);

// Answering comments on a document, or a question on a ticket someone else has, changes nothing on the ticket.
// Trying to unblock a ticket is not a hand-back on it either: the ticket stays as it is.
const NOT_ON_TICKET = new Set(["doc_feedback", "asked", "unblock"]);

/** What the event is about: the ticket, or the pull request with its ticket. Nothing for other subjects. */
async function eventSubject(
  store: Store,
  subject: NonNullable<WorkItem["subject"]>,
): Promise<WorkflowEvent["subject"] | undefined> {
  if (subject.type === "ticket") {
    return { ticket: subject.ref };
  }

  if (subject.type !== "pr") {
    return undefined;
  }

  const pr = (await store.getSubject("pr", subject.ref))?.data as PrRecord | undefined;
  return pr ? { pr: pr.ref, ...(pr.ticket ? { ticket: pr.ticket } : {}) } : undefined;
}

/** What follows an agent's hand-back of an item: an `agent.handed_back` event for its ticket or pull request. */
export function createHandedBack(deps: {
  store: Store;
  workState: WorkState;

  /** Has the event judged by the pipeline. */
  judge: (event: WorkflowEvent, meta: { source: string; externalId: string }) => Promise<unknown>;
  log: Logger;
}) {
  const { store, workState, judge, log } = deps;
  return async (item: WorkItem): Promise<void> => {
    if (!HANDED_BACK.has(item.status) || !item.subject || NOT_ON_TICKET.has(item.kind)) {
      return;
    }

    const subject = await eventSubject(store, item.subject);
    if (!subject) {
      return;
    }

    const runs = await store.listRuns(item.id);
    const event: WorkflowEvent = {
      type: "agent.handed_back",
      subject,
      actor: { kind: "agent", id: item.person },
      data: { workItem: item.id, kind: item.kind, status: item.status },
    };

    // The policies read who last worked on the ticket, and the ticket itself, from the state. The agent may have moved or
    // assigned the ticket during the round, after the tracker was last polled, so both are re-read first.
    await Promise.all([
      workState.refreshWorkers(),
      ...(subject.ticket ? [workState.refreshTicket(subject.ticket)] : []),
    ]).catch((error: unknown) => {
      log.warn("refreshing the state before a hand-back failed", { error: String(error) });
    });

    await judge(event, {
      source: "workstate",
      externalId: `handed_back:${item.id}:${runs.at(-1)?.id ?? "0"}`,
    });

    log.info(handedBackText(item), { person: item.person });
  };
}
