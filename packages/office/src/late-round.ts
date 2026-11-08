import { CHAT_ORIGIN_SUBJECT, readOrigin } from "./chat/origin.js";
import type { ChatOriginRecord } from "./chat/types.js";
import type { LateInput, LateRoundOptions } from "./late-round.types.js";
import { CHAT_KIND } from "#/scheduler/policy.js";
import type { Conversation, Store, WorkItem } from "./store/types.js";
import { addFeedback, deliverFeedback, FOLLOW_UP_SUBJECT } from "./work-feedback.js";

/** The answers that arrived while the asker was working, for a journal. */
export function lateAnswers(answers: Conversation[]): string {
  const lines = answers.map(
    (c) => `- ${c.target} on question ${c.id} (${c.question}): ${c.answer ?? ""}`,
  );

  return `Answers that arrived while you were working:\n${lines.join("\n")}`;
}

const answerers = (answers: Conversation[]) =>
  [...new Set(answers.map((c) => c.target))].join(", ");

/** The item's follow-up round, while it has not started: later input joins it instead of queuing another. */
async function queuedFollowUp(store: Store, itemId: string): Promise<WorkItem | undefined> {
  const id = ((await store.getSubject(FOLLOW_UP_SUBJECT, itemId))?.data as { itemId?: string })
    ?.itemId;

  const item = id ? await store.getItem(id) : undefined;
  return item?.status === "queued" ? item : undefined;
}

/** The item's chat threads, for a round that answers its late chat feedback in them. */
async function carryOrigin(store: Store, from: WorkItem, to: WorkItem): Promise<void> {
  const origin = await readOrigin(store, from.id);
  if (!origin || (await readOrigin(store, to.id))) {
    return;
  }

  await store.upsertSubject(CHAT_ORIGIN_SUBJECT, to.id, {
    channel: origin.channel,
    thread: origin.thread,
    requester: origin.requester,
    direct: origin.direct,
    participant: origin.participant,
    claimed: [],
    ...(origin.also ? { also: origin.also } : {}),
  } satisfies ChatOriginRecord);
}

/**
 * Hands the late input to the follow-up round: the feedback (counted as delivered on the finished item, so it is
 * carried once), its references and chat threads, and the answers in its journal with the asker's session, which
 * asked the questions. A chat session's answers also take its threads, so the round tells the requester there.
 */
async function carry(store: Store, item: WorkItem, round: WorkItem, late: LateInput) {
  if (late.feedback.length > 0) {
    await store.addItemRefs(round.id, await store.listItemRefs(item.id));
    for (const feedback of late.feedback) {
      await addFeedback(store, round.id, feedback);
    }

    await carryOrigin(store, item, round);
    await deliverFeedback(store, item.id);
  }

  if (late.answers.length > 0) {
    await store.appendJournal(round.id, "office", lateAnswers(late.answers));
    if (!round.sessionId) {
      await store.updateItem(round.id, { sessionId: item.sessionId, workspace: item.workspace });
    }

    if (item.kind === CHAT_KIND) {
      await carryOrigin(store, item, round);
    }
  }
}

/** A new follow-up round of a finished item, with everything stored before it can be offered. */
async function queueFollowUp(opts: LateRoundOptions, item: WorkItem, late: LateInput) {
  const fed = late.feedback.length > 0;
  const round = await opts.scheduler.enqueue({
    person: item.person,
    kind: item.kind,
    title: fed ? item.title : `Answer from ${answerers(late.answers)}: ${item.title}`,
    trigger: fed ? item.trigger : "agent",
    ...(fed ? { priority: item.priority } : {}),
    parentId: item.id,
    ...(item.subject ? { subject: item.subject } : {}),
    init: (created) => carry(opts.store, item, created, late),
  });

  await opts.store.upsertSubject(FOLLOW_UP_SUBJECT, item.id, { itemId: round.id });
  return round;
}

/**
 * Gives an item's late input one round. A waiting item is queued again and takes all of it with its next offer and
 * journal. A finished or blocked item gets one follow-up round that carries it: the follow-up queued earlier when it
 * has not started yet, else a new one. A queued item takes it with its next offer anyway. Returns the round, or
 * nothing when there is nothing to take or the item takes it itself.
 */
export function lateRound(opts: LateRoundOptions) {
  const { store } = opts;
  return async (item: WorkItem, late: LateInput): Promise<WorkItem | undefined> => {
    if (late.feedback.length === 0 && late.answers.length === 0) {
      return undefined;
    }

    if (item.status === "waiting") {
      return store.updateItem(item.id, { status: "queued" });
    }

    if (item.status === "queued" || item.status === "active") {
      return undefined;
    }

    const joined = await queuedFollowUp(store, item.id);
    if (!joined) {
      return queueFollowUp(opts, item, late);
    }

    await carry(store, item, joined, late);
    return (await store.getItem(joined.id)) ?? joined;
  };
}
