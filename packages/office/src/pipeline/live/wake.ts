import { addFeedback } from "#/engine/feedback.js";
import { triggerRefs } from "#/refs/index.js";
import { priorityFor } from "#/scheduler/index.js";
import type { WorkItemTrigger } from "#/store/types.js";
import type { Wake } from "#/pipeline/decisions.types.js";
import type { PipelineEvent } from "#/pipeline/events.types.js";
import type { LiveOptions, WakeReason } from "./live.types.js";

export const WAKE_SUBJECT = "pipeline_wake";

/** The events whose wakes queued or joined an item, by item id, in the order they came. */
export const ITEM_EVENTS_SUBJECT = "pipeline_item_events";
const LIVE = new Set(["queued", "active"]);

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

function titleOf(event: PipelineEvent, wake: Wake, opts: LiveOptions): string {
  const kind = wake.kind.replaceAll(/[_-]/g, " ");
  const pr = event.subject.pr && opts.workState.pullRequest(event.subject.pr);
  const what =
    wake.subject.type === "pr" && event.subject.pr
      ? `PR #${event.subject.pr.number}${pr ? ` ${pr.title}` : ""}`
      : wake.subject.type === "ticket"
        ? `${wake.subject.ref} ${opts.workState.ticket(wake.subject.ref)?.title ?? ""}`.trim()
        : wake.subject.ref;

  return `${kind}: ${what}`;
}

async function linkEvent(opts: LiveOptions, itemId: string, eventId: string) {
  const ids =
    ((await opts.store.getSubject(ITEM_EVENTS_SUBJECT, itemId))?.data as string[] | undefined) ??
    [];

  if (!ids.includes(eventId)) {
    await opts.store.upsertSubject(ITEM_EVENTS_SUBJECT, itemId, [...ids, eventId]);
  }
}

/**
 * Queues the run a wake asks for, as the engine schedules one: a wake for an item of the same kind and subject that
 * is queued or running adds its feedback to that item instead. The instruction goes in the item's journal.
 */
export async function enqueueWake(
  wake: Wake,
  event: PipelineEvent,
  opts: LiveOptions,
): Promise<{ itemId: string; joined: boolean }> {
  const subject = itemSubject(event, wake, opts);
  const live = (await opts.store.listItems({ person: wake.person })).find(
    (i) =>
      LIVE.has(i.status) &&
      i.kind === wake.kind &&
      i.subject?.type === subject.type &&
      i.subject.ref === subject.ref,
  );

  const refs = triggerRefs(event.subject, event.id, opts.workState.prSubject);
  if (live) {
    for (const f of wake.feedback) {
      await addFeedback(opts.store, live.id, f);
    }

    await opts.store.addItemRefs(live.id, refs);

    await linkEvent(opts, live.id, event.id);
    return { itemId: live.id, joined: true };
  }

  const trigger = triggerOf(event);
  const reason: WakeReason = { event: event.id, policy: wake.policy };
  const item = await opts.scheduler.enqueue({
    person: wake.person,
    kind: wake.kind,
    title: titleOf(event, wake, opts),
    trigger,
    priority: priorityFor(trigger, wake.kind),
    subject,
    source: event.id,
    refs,
    init: async (created) => {
      for (const f of wake.feedback) {
        await addFeedback(opts.store, created.id, f);
      }

      await opts.store.appendJournal(created.id, "office", wake.instruction);
      await opts.store.upsertSubject(WAKE_SUBJECT, created.id, reason);
      await linkEvent(opts, created.id, event.id);
    },
  });

  return { itemId: item.id, joined: false };
}
