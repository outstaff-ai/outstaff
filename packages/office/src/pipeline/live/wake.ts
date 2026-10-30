import { addFeedback } from "#/work-feedback.js";
import { triggerRefs } from "#/refs/index.js";
import { priorityFor } from "#/scheduler/index.js";
import { chatTitle, joinChatSession, messageOf, openChatSession } from "#/chat/session.js";
import type { WorkItem, WorkItemTrigger } from "#/store/types.js";
import type { Wake } from "#/pipeline/decisions.types.js";
import type { PipelineEvent } from "#/pipeline/events.types.js";
import type { LiveOptions, WakeReason } from "./live.types.js";

export const WAKE_SUBJECT = "pipeline_wake";

/** The events whose wakes queued or joined an item, by item id, in the order they came. */
export const ITEM_EVENTS_SUBJECT = "pipeline_item_events";
const LIVE = new Set(["queued", "active"]);

/** A running chat session sees no later message, so a message joins only a session that has not started. */
const CHAT_LIVE = new Set(["queued"]);

/** An idle agent's pull is the office's own doing: automatic work, like the scheduler's. */
const triggerOf = (event: PipelineEvent): WorkItemTrigger =>
  event.type === "agent.idle" ? "automation" : event.actor.kind;

/** The work item subject of a wake: the work state's key for a pull request, else the ticket or document. */
function itemSubject(event: PipelineEvent, wake: Wake, opts: LiveOptions) {
  const pr = event.subject.pr;
  if (wake.subject.type === "pr" && pr) {
    return { type: "pr", ref: opts.workState.prSubject(pr) };
  }

  return { type: wake.subject.type, ref: wake.subject.ref };
}

function whatOf(event: PipelineEvent, wake: Wake, opts: LiveOptions): string {
  const { pr } = event.subject;
  if (wake.subject.type === "pr" && pr) {
    const known = opts.workState.pullRequest(pr);
    return `PR #${pr.number}${known ? ` ${known.title}` : ""}`;
  }

  if (wake.subject.type === "ticket") {
    return `${wake.subject.ref} ${opts.workState.ticket(wake.subject.ref)?.title ?? ""}`.trim();
  }

  return wake.subject.ref;
}

function titleOf(event: PipelineEvent, wake: Wake, opts: LiveOptions): string {
  const m = wake.subject.type === "chat" ? messageOf(event.data) : undefined;
  return m ? chatTitle(m) : `${wake.kind.replaceAll(/[_-]/g, " ")}: ${whatOf(event, wake, opts)}`;
}

/** Adds the event to the item's events; returns them all, in the order they came. */
async function linkEvent(opts: LiveOptions, itemId: string, eventId: string): Promise<string[]> {
  const ids =
    ((await opts.store.getSubject(ITEM_EVENTS_SUBJECT, itemId))?.data as string[] | undefined) ??
    [];

  if (ids.includes(eventId)) {
    return ids;
  }

  const all = [...ids, eventId];
  await opts.store.upsertSubject(ITEM_EVENTS_SUBJECT, itemId, all);
  return all;
}

/** How long wakes for the same person and subject fold into one run; an idle pull has nothing to wait for. */
const windowMs = (event: PipelineEvent, opts: LiveOptions) =>
  event.type === "agent.idle" ? 0 : (opts.team.pipeline?.wake?.coalesce_seconds ?? 60) * 1000;

/**
 * Adds a wake to an item queued or running for an earlier one: its feedback, what it refers to, and its instruction
 * when the item is of another kind. Returns the item's events.
 */
async function join(item: WorkItem, wake: Wake, event: PipelineEvent, opts: LiveOptions) {
  for (const f of wake.feedback) {
    await addFeedback(opts.store, item.id, f);
  }

  await opts.store.addItemRefs(
    item.id,
    triggerRefs(event.subject, event.id, opts.workState.prSubject),
  );

  const m = messageOf(event.data);
  if (m) {
    await joinChatSession(opts.store, item.id, m);
  }

  if (item.kind !== wake.kind) {
    await opts.store.appendJournal(item.id, "office", wake.instruction);
  }

  return linkEvent(opts, item.id, event.id);
}

/** The item's first wake: its feedback, the instruction in its journal, why it was queued, and a chat session's origin. */
async function init(item: WorkItem, wake: Wake, event: PipelineEvent, opts: LiveOptions) {
  for (const f of wake.feedback) {
    await addFeedback(opts.store, item.id, f);
  }

  await opts.store.appendJournal(item.id, "office", wake.instruction);
  await opts.store.upsertSubject(WAKE_SUBJECT, item.id, {
    event: event.id,
    policy: wake.policy,
  } satisfies WakeReason);

  const m = messageOf(event.data);
  if (m && wake.subject.type === "chat") {
    await openChatSession(opts.store, item, m);
  }

  await linkEvent(opts, item.id, event.id);
}

/**
 * Queues the run a wake asks for. A wake for an item of the same kind and subject that is queued or running joins that
 * item (a chat message only one that is queued: a running session does not see it); a wake for the same person and subject within `pipeline.wake.coalesce_seconds` of the first is folded into
 * the item the first queued, which is held until then. `folded` lists the events of the item it joined, this one last.
 */
export async function enqueueWake(
  wake: Wake,
  event: PipelineEvent,
  opts: LiveOptions,
): Promise<{ itemId: string; folded?: string[] }> {
  const subject = itemSubject(event, wake, opts);
  const joinable = wake.subject.type === "chat" ? CHAT_LIVE : LIVE;
  const live = (await opts.store.listItems({ person: wake.person })).find(
    (i) =>
      joinable.has(i.status) &&
      i.kind === wake.kind &&
      i.subject?.type === subject.type &&
      i.subject.ref === subject.ref,
  );

  if (live) {
    return { itemId: live.id, folded: await join(live, wake, event, opts) };
  }

  let folded: string[] | undefined;
  const trigger = triggerOf(event);
  const item = await opts.scheduler.enqueue({
    person: wake.person,
    kind: wake.kind,
    title: titleOf(event, wake, opts),
    trigger,
    priority: priorityFor(trigger, wake.kind),
    subject,
    source: event.id,
    refs: triggerRefs(event.subject, event.id, opts.workState.prSubject),
    init: (created) => init(created, wake, event, opts),
    coalesce: {
      key: JSON.stringify([wake.person, subject.type, subject.ref]),
      at: event.at,
      windowMs: windowMs(event, opts),
      fold: async (into) => {
        folded = await join(into, wake, event, opts);
      },
    },
  });

  return { itemId: item.id, ...(folded ? { folded } : {}) };
}
