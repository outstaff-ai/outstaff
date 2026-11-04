import { policyOn } from "@outstaff/core";
import { lateAnswers, lateRound } from "./late-round.js";
import type { OfficeRounds, OfficeRoundsOptions } from "./office-rounds.types.js";
import type { WorkItem } from "./store/types.js";
import { undeliveredFeedback } from "./work-feedback.js";

/** Kinds that only answer something on a ticket, or start from it: finishing one settles nothing. */
const ANSWERS = new Set(["asked", "doc_feedback", "unblock", "milestone"]);

/** The statuses a hand-back leaves an asker in that take the answers that came while it ran; a blocked one keeps them. */
const TAKES_ANSWERS = new Set<string>(["waiting", "done"]);

/**
 * The office's bookkeeping of an item's rounds after a hand-back, which decides nothing and changes nothing outside the
 * office: what reached the item while it ran (feedback after its offer, answers to its questions) gets one more round,
 * and blocked items the finished work made moot are closed.
 */
export function createOfficeRounds(opts: OfficeRoundsOptions): OfficeRounds {
  const { store, scheduler, workState, team, logger, notify } = opts;

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

  const take = lateRound({ store, scheduler });

  /** What reached the item after its offer: feedback (`policies.feedback.follow_up_round`) and answers it may take. */
  const lateInput = async (item: WorkItem) => ({
    feedback: policyOn(team.policies, "feedback.follow_up_round")
      ? await undeliveredFeedback(store, item.id)
      : [],
    answers: TAKES_ANSWERS.has(item.status) ? await store.listUndelivered(item.id) : [],
  });

  const followUp = async (itemId: string): Promise<void> => {
    const item = await store.getItem(itemId);
    if (!item) {
      return;
    }

    const late = await lateInput(item);
    if (late.answers.length > 0) {
      await store.appendJournal(itemId, "office", lateAnswers(late.answers));
    }

    const round = await take(item, late);
    if (!round) {
      return;
    }

    for (const c of late.answers) {
      await store.markDelivered(c.id);
    }

    notify?.(item.person);
    const answers = late.answers.length;
    const what = `${late.feedback.length} new feedback and ${answers} answer${answers === 1 ? "" : "s"}`;
    logger.info(
      round.id === item.id
        ? `queued work item ${item.id} for ${item.person} again: ${what} while it ran`
        : `queued follow-up work item ${round.id} for ${item.person}: ${what} after ${item.id} was offered`,
      { person: item.person, item: round.id, after: item.id },
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
