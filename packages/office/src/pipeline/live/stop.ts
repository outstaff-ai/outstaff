import type { PipelineEvent } from "@outstaff/policy";
import { itemTicket } from "#/item-ticket.js";
import type { Stop } from "#/pipeline/decisions.types.js";
import { CHAT_KIND, priorityFor, TICKET_CLOSED_KIND } from "#/scheduler/index.js";
import type { Store, WorkItem } from "#/store/types.js";
import { isTerminal, type WorkState } from "#/workstate/index.js";
import type { LiveOptions, StopRecord } from "./live.types.js";

/** The subject type that keeps the latest stop of each closed ticket, by ticket key. */
export const STOP_SUBJECT = "ticket_stop";

/** Work not started yet: canceled. Active work gets the notice; blocked work stays blocked. */
const PENDING = new Set<string>(["queued", "waiting"]);

/** Work a stop leaves alone whoever it is for: chat sessions, and the notice rounds a stop queues itself. */
const SPARED_KINDS = new Set([CHAT_KIND, TICKET_CLOSED_KIND]);

type Reader = Pick<Store, "getSubject">;

const readStop = async (store: Reader, ticket: string) =>
  (await store.getSubject(STOP_SUBJECT, ticket))?.data as StopRecord | undefined;

/** The journal line of a canceled item: who closed the ticket, and when. */
function canceledLine(stop: Stop, event: PipelineEvent): string {
  const by = (event.data["closedBy"] as { id?: unknown } | undefined)?.id;
  const how = event.data["status"] === "canceled" ? "canceled" : "closed as done";
  return `Canceled: ${stop.ticket} was ${how} by ${typeof by === "string" ? by : "someone"} at ${event.at}, before this work started.`;
}

/** Whether the stop is about the item: open work of someone it does not spare, on the ticket or its pull requests. */
async function stops(stop: Stop, item: WorkItem, store: Reader): Promise<boolean> {
  if (SPARED_KINDS.has(item.kind) || stop.except.includes(item.person)) {
    return false;
  }

  if (!PENDING.has(item.status) && item.status !== "active") {
    return false;
  }

  return (await itemTicket(store, item)) === stop.ticket;
}

/** The notice for running work: a round of its own, first in the person's queue, so it starts when the running one ends. */
async function queueNotice(stop: Stop, item: WorkItem, event: PipelineEvent, opts: LiveOptions) {
  const title = opts.workState.ticket(stop.ticket)?.title ?? "";
  const notice = await opts.scheduler.enqueue({
    person: item.person,
    kind: TICKET_CLOSED_KIND,
    title: `ticket closed: ${stop.ticket} ${title}`.trim(),
    trigger: "automation",
    priority: priorityFor("automation", TICKET_CLOSED_KIND),
    placement: "next",
    // The stop found the item through its subject, so it has one.
    subject: item.subject!,
    source: event.id,
    init: async (created) => {
      await opts.store.appendJournal(
        created.id,
        "office",
        `${stop.notice} (You were working on it in work item ${item.id}.)`,
      );
    },
  });

  await opts.store.appendJournal(
    item.id,
    "office",
    `${stop.ticket} was closed while this ran; work item ${notice.id} tells the agent once it ends.`,
  );

  return notice.id;
}

/**
 * Stops the work on a closed ticket, once per event: every queued or waiting item on it (or on its pull requests) of
 * an agent the stop does not spare is canceled, with a journal line naming who closed the ticket and when; an agent
 * running such work gets the notice as a round of its own, which starts when the running one ends. A running session
 * sees nothing new: like a follow-up attached to running work, the notice is picked up after the hand-back. The stop is
 * recorded for the ticket, so an item it left queued (blocked at the time, for example) is skipped when it would start.
 */
export async function stopWork(
  stop: Stop,
  event: PipelineEvent,
  opts: LiveOptions,
): Promise<StopRecord> {
  const prior = await readStop(opts.store, stop.ticket);
  if (prior?.event === event.id) {
    return prior;
  }

  const record: StopRecord = {
    event: event.id,
    at: opts.clock.now().toISOString(),
    except: stop.except,
    line: canceledLine(stop, event),
    canceled: [],
    noticed: [],
  };

  for (const item of await opts.store.listItems()) {
    if (!(await stops(stop, item, opts.store))) {
      continue;
    }

    if (item.status === "active") {
      record.noticed.push(await queueNotice(stop, item, event, opts));
      continue;
    }

    await opts.store.updateItem(item.id, { status: "canceled" });
    await opts.store.appendJournal(item.id, "office", record.line);
    record.canceled.push(item.id);
    opts.logger.info(`pipeline: canceled work item ${item.id} for ${item.person}: ${record.line}`);
  }

  await opts.store.upsertSubject(STOP_SUBJECT, stop.ticket, record);
  return record;
}

/**
 * The start-time check: why a queued item must not start any more, or undefined. It must not when its ticket is still
 * closed and a stop of that ticket came after the item was queued and does not spare its person; work queued after the
 * stop (feedback on a merged pull request, a notice round) is new and starts.
 */
export function stoppedWork(deps: { store: Reader; workState: Pick<WorkState, "ticket"> }) {
  return async (item: WorkItem): Promise<string | undefined> => {
    if (SPARED_KINDS.has(item.kind)) {
      return undefined;
    }

    const ticket = await itemTicket(deps.store, item);
    const stop = ticket ? await readStop(deps.store, ticket) : undefined;
    if (!stop || stop.except.includes(item.person) || item.createdAt > stop.at) {
      return undefined;
    }

    return isTerminal(deps.workState.ticket(ticket!)?.status) ? stop.line : undefined;
  };
}
