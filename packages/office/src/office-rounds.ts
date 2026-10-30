import { policyOn } from "@outstaff/core";
import { CHAT_ORIGIN_SUBJECT, readOrigin } from "./chat/origin.js";
import type { ChatOriginRecord } from "./chat/types.js";
import type { OfficeRounds, OfficeRoundsOptions } from "./office-rounds.types.js";
import type { WorkItem } from "./store/types.js";
import { addFeedback, FOLLOW_UP_SUBJECT, undeliveredFeedback } from "./work-feedback.js";

/** Kinds that only answer something on a ticket: finishing one settles nothing. */
const ANSWERS = new Set(["asked", "doc_feedback", "unblock"]);

/**
 * The office's bookkeeping of an item's rounds after a hand-back, which decides nothing and changes nothing outside the
 * office: feedback that came after the offer gets a round of its own, and blocked items the finished work made moot
 * are closed.
 */
export function createOfficeRounds(opts: OfficeRoundsOptions): OfficeRounds {
  const { store, scheduler, workState, team, logger } = opts;

  // One hand-back at a time: both read the work queue.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  /** The ticket an item is about, directly or through its pull request. */
  const ticketOf = async (item: WorkItem): Promise<string | undefined> => {
    if (item.subject?.type === "ticket") {
      return item.subject.ref;
    }

    return item.subject?.type === "pr"
      ? ((await store.getSubject("pr", item.subject.ref))?.data as { ticket?: string } | undefined)
          ?.ticket
      : undefined;
  };

  const followUp = async (itemId: string): Promise<void> => {
    if (
      !policyOn(team.policies, "feedback.follow_up_round") ||
      (await store.getSubject(FOLLOW_UP_SUBJECT, itemId)) !== undefined
    ) {
      return;
    }

    const late = await undeliveredFeedback(store, itemId);
    const item = await store.getItem(itemId);
    if (!item || late.length === 0) {
      return;
    }

    // A request from chat that reached the item late is answered in the same threads.
    const origin = await readOrigin(store, itemId);
    const next = await scheduler.enqueue({
      person: item.person,
      kind: item.kind,
      title: item.title,
      trigger: item.trigger,
      priority: item.priority,
      parentId: item.id,
      ...(item.subject ? { subject: item.subject } : {}),
      // Stored before the item can be offered: an offer without its feedback or origin would never be repeated.
      init: async (created) => {
        await store.addItemRefs(created.id, await store.listItemRefs(itemId));
        for (const feedback of late) {
          await addFeedback(store, created.id, feedback);
        }

        if (origin) {
          await store.upsertSubject(CHAT_ORIGIN_SUBJECT, created.id, {
            channel: origin.channel,
            thread: origin.thread,
            requester: origin.requester,
            direct: origin.direct,
            participant: origin.participant,
            awaitingPlacement: false,
            claimed: [],
            ...(origin.also ? { also: origin.also } : {}),
          } satisfies ChatOriginRecord);
        }
      },
    });

    await store.upsertSubject(FOLLOW_UP_SUBJECT, itemId, { itemId: next.id });
    logger.info(
      `queued follow-up work item ${next.id} for ${item.person}: ${late.length} new feedback after ${item.id} was offered`,
      { person: item.person, item: next.id, after: item.id },
    );
  };

  /** The ticket a finished item settled: it was done, it worked on the ticket, and the ticket is not blocked. */
  const settledTicket = async (item: WorkItem): Promise<string | undefined> => {
    const ticket = await ticketOf(item);
    const settles = item.status === "done" && !ANSWERS.has(item.kind);
    return ticket && settles && workState.ticket(ticket)?.status !== "blocked" ? ticket : undefined;
  };

  const settle = async (item: WorkItem): Promise<void> => {
    const ticket = await settledTicket(item);
    if (!ticket) {
      return;
    }

    const moot = async (old: WorkItem) =>
      old.id !== item.id &&
      old.person === item.person &&
      old.kind !== "unblock" &&
      (await ticketOf(old)) === ticket;

    for (const old of await store.listItems({ status: "blocked" })) {
      if (!(await moot(old))) {
        continue;
      }

      await store.updateItem(old.id, { status: "canceled" });
      await store.appendJournal(
        old.id,
        "office",
        `Closed: work item ${item.id} finished the work on ${ticket}.`,
      );

      logger.info(`closed blocked work item ${old.id}, ${item.id} finished ${ticket}`, {
        item: old.id,
        by: item.id,
        ticket,
      });
    }
  };

  return {
    followUp: (itemId) => serial(() => followUp(itemId)),
    settle: (item) => serial(() => settle(item)),
  };
}
