import type { PipelineEvent, SuppressProposal, WakeProposal } from "@outstaff/policy";
import { prLabel } from "#/log.js";
import { conversationRef } from "#/refs/index.js";
import type { Wake, WakeSubject } from "#/pipeline/decisions.types.js";
import { feedbackFor } from "#/pipeline/feedback.js";
import type { AggregateInput, Slot } from "./aggregate.types.js";

const DEFAULT_COALESCE_MS = 60_000;

function eventSubject(event: PipelineEvent): WakeSubject | undefined {
  const { pr, ticket, doc, chat } = event.subject;
  if (pr) {
    return { type: "pr", ref: prLabel(pr) };
  }

  if (ticket) {
    return { type: "ticket", ref: ticket };
  }

  if (doc) {
    return { type: "doc", ref: doc };
  }

  return chat ? { type: "chat", ref: conversationRef(chat) } : undefined;
}

/**
 * How long a wake waits for related ones to join its run. A chat message is answered at once, though a message for a
 * session still queued joins it; an idle pull has nothing to wait for. Everything else waits the team's window.
 */
const coalesceMs = (p: WakeProposal, { event, options }: AggregateInput): number =>
  p.kind === "chat" || event.type === "agent.idle"
    ? 0
    : (options.coalesceMs ?? DEFAULT_COALESCE_MS);

/** The wake a proposal becomes: its subject (the event's, unless it named one), the event's feedback, its window. */
export function wakeOf(slot: Slot, p: WakeProposal, input: AggregateInput): void {
  const subject = p.subject ?? eventSubject(input.event);
  if (!subject) {
    const reason = "the event has no ticket, pull request, document or chat thread";
    slot.outcome = "dropped";
    slot.reason = reason;
    slot.decision = { type: "drop", policy: slot.policy, reason };
    return;
  }

  slot.outcome = "kept";
  slot.decision = {
    type: "wake",
    policy: slot.policy,
    person: p.person,
    kind: p.kind,
    instruction: p.instruction,
    feedback: feedbackFor(input.event),
    subject,
    coalesceMs: coalesceMs(p, input),
  };
}

const sameSubject = (a: WakeSubject, b: WakeSubject) => a.type === b.type && a.ref === b.ref;

const suppresses = (s: SuppressProposal, w: Wake) =>
  s.person === w.person &&
  (s.subject === undefined || sameSubject(s.subject, w.subject)) &&
  (s.kind === undefined || s.kind === w.kind);

/** A suppression beats every wake it matches, whatever the priorities: the wake is dropped with its reason. */
export function applySuppressions(slots: readonly Slot[]): void {
  const wakes = slots.filter((s) => s.decision?.type === "wake");
  for (const slot of slots) {
    const p = slot.proposal;
    if (p.type !== "suppress" || slot.outcome === "rejected") {
      continue;
    }

    const hit = wakes.filter((w) => w.outcome === "kept" && suppresses(p, w.decision as Wake));
    for (const w of hit) {
      const reason = `suppressed by ${slot.policy}: ${p.reason}`;
      w.outcome = "suppressed";
      w.reason = reason;
      w.decision = { type: "drop", policy: w.policy, reason };
    }

    slot.outcome = "kept";
    slot.reason =
      hit.length > 0
        ? `suppressed the wake of ${p.person} by ${hit.map((w) => w.policy).join(", ")}`
        : `no wake of ${p.person} to suppress`;
  }
}

const keyOf = (w: Wake) => JSON.stringify([w.person, w.subject.type, w.subject.ref, w.kind]);

/**
 * Wakes for the same person, subject and kind become one run: the first gains the others' instructions, the event's
 * feedback is carried once, and it waits the shortest of their windows. Wakes of different kinds are different runs.
 */
export function mergeWakes(slots: readonly Slot[]): void {
  const first = new Map<string, Slot>();
  const given = new Map<Slot, Set<string>>();
  for (const slot of slots) {
    if (slot.decision?.type !== "wake") {
      continue;
    }

    const wake = slot.decision;
    const into = first.get(keyOf(wake));
    if (!into) {
      first.set(keyOf(wake), slot);
      given.set(slot, new Set([wake.instruction]));
      continue;
    }

    const kept = into.decision as Wake;
    const instructions = given.get(into)!;
    if (!instructions.has(wake.instruction)) {
      instructions.add(wake.instruction);
      kept.instruction = `${kept.instruction}\n\n${wake.instruction}`;
    }

    kept.coalesceMs = Math.min(kept.coalesceMs, wake.coalesceMs);
    slot.outcome = "merged";
    slot.reason = `merged into the wake of ${wake.person} by ${into.policy}`;
    slot.decision = undefined;
    slot.into = into;
  }
}
