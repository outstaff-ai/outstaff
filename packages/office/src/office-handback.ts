import type { Logger, WorkflowEvent } from "@outstaff/core";
import { readOrigin } from "./chat/origin.js";
import { itemEventSubject } from "./office-item-subject.js";
import { PR_OPEN_SOURCE } from "./office-work-made.js";
import { ROUND_START } from "./round-start.js";
import type { HandBackResult } from "./work-source.types.js";
import type { Store, WorkItem } from "./store/types.js";
import type { WorkState } from "./workstate/index.js";

const handedBackText = (item: WorkItem) => `handed back ${item.id}`;

const HANDED_BACK = new Set(["done", "waiting", "blocked"]);

/**
 * The item's tickets besides the one it is about: those its agent created (`created`), and those of the pull requests
 * it opened (`opened`). A hand-back gives the ones that are in review to the requester too.
 */
async function madeTickets(
  store: Store,
  workState: WorkState,
  item: WorkItem,
  own: string | undefined,
) {
  const refs = await store.listItemRefs(item.id);
  const prs = new Set(
    refs.filter((r) => r.type === "pr" && r.role === "created").map((r) => r.ref),
  );

  const tickets = refs.filter((r) => r.type === "ticket" && r.ref !== own);
  const opened = (key: string) =>
    workState.prsOfTicket(key).some((p) => prs.has(workState.prSubject(p.ref)));

  const keys = (keep: (r: (typeof tickets)[number]) => boolean) => [
    ...new Set(tickets.filter(keep).map((r) => r.ref)),
  ];

  return {
    created: keys((r) => r.role === "created"),
    opened: keys((r) => r.source === PR_OPEN_SOURCE || opened(r.ref)),
  };
}

// Answering comments on a document, or a question on a ticket someone else has, changes nothing on the ticket.
// Trying to unblock a ticket is not a hand-back on it either, nor the PM's round on a milestone its closing finished:
// the ticket stays as it is.
const NOT_ON_TICKET = new Set(["doc_feedback", "asked", "unblock", "milestone"]);

/** The hand-back's status: the item's, except a silent finish, which leaves the item done and the ticket alone. */
const statusOf = (item: WorkItem, result: Pick<HandBackResult, "status">) =>
  result.status === "silent" ? "silent" : item.status;

/** For a silent finish: the ticket as the round found it, which it is put back to (`hand_back_silent_restores`). */
async function beforeOf(
  store: Pick<Store, "getSubject">,
  item: WorkItem,
  result: Pick<HandBackResult, "status">,
  ticket: string | undefined,
) {
  if (result.status !== "silent" || !ticket) {
    return undefined;
  }

  const start = (await store.getSubject(ROUND_START, item.id))?.data as
    | { ticket: string; status?: string; assignee?: { id: string; kind: string } }
    | undefined;

  return start?.ticket === ticket
    ? { status: start.status, ...(start.assignee ? { assignee: start.assignee } : {}) }
    : undefined;
}

/** The hand-back event's data: the item, its status and summary, and for a silent finish the ticket before the round. */
async function dataOf(
  store: Pick<Store, "getSubject">,
  item: WorkItem,
  result: Pick<HandBackResult, "summary" | "status">,
  ticket: string | undefined,
) {
  const before = await beforeOf(store, item, result, ticket);
  return {
    workItem: item.id,
    kind: item.kind,
    status: statusOf(item, result),
    summary: result.summary,
    ...(before ? { before } : {}),
  };
}

/** Re-reads who last worked on what, and the tickets, as the agent's hand-back is what they are read for. */
const refresh = (workState: WorkState, person: string, tickets: string[]) =>
  Promise.all([
    workState.refreshWorkers(),
    ...tickets.map((key) => workState.refreshTicket(key, { kind: "agent", id: person })),
  ]);

/** Work from a chat thread gets its result there (the chat desk's report): `chat` says so. */
async function fromChat(store: Store, item: WorkItem): Promise<{ chat?: true }> {
  const origin = await readOrigin(store, item.id);
  return origin && !origin.filed ? { chat: true } : {};
}

/**
 * What follows an agent's hand-back of an item: an `agent.handed_back` event for its ticket or pull request, with the
 * summary the agent handed back.
 */
export function createHandedBack(deps: {
  store: Store;
  workState: WorkState;

  /** Has the event judged by the pipeline. */
  judge: (event: WorkflowEvent, meta: { source: string; externalId: string }) => Promise<unknown>;
  log: Logger;
}) {
  const { store, workState, judge, log } = deps;
  return async (
    item: WorkItem,
    result: Pick<HandBackResult, "summary" | "status">,
  ): Promise<void> => {
    if (!HANDED_BACK.has(item.status) || !item.subject || NOT_ON_TICKET.has(item.kind)) {
      return;
    }

    const subject = await itemEventSubject(store, item.subject);
    if (!subject) {
      return;
    }

    const runs = await store.listRuns(item.id);
    const made = await madeTickets(store, workState, item, subject.ticket);
    const event: WorkflowEvent = {
      type: "agent.handed_back",
      subject,
      actor: { kind: "agent", id: item.person },
      data: {
        ...(await dataOf(store, item, result, subject.ticket)),
        ...(await fromChat(store, item)),
        ...made,
      },
    };

    // The policies read who last worked on the tickets, and the tickets themselves, from the state. The agent may have
    // moved or assigned them during the round, after the tracker was last polled, so all are re-read first.
    const tickets = [
      ...new Set([...(subject.ticket ? [subject.ticket] : []), ...made.created, ...made.opened]),
    ];

    await refresh(workState, item.person, tickets).catch((error: unknown) => {
      log.warn("refreshing the state before a hand-back failed", { error: String(error) });
    });

    await judge(event, {
      source: "workstate",
      externalId: `handed_back:${item.id}:${runs.at(-1)?.id ?? "0"}`,
    });

    log.info(handedBackText(item), { person: item.person });
  };
}
