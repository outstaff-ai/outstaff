import type { CoalescedWake, PendingWake } from "./coalesce.types.js";

const keyOf = (w: PendingWake) =>
  JSON.stringify([w.wake.person, w.wake.subject.type, w.wake.subject.ref]);

const addNew = <T>(list: T[], item: T) => (list.includes(item) ? list : [...list, item]);

/**
 * Folds wakes for the same person and subject into one run when they happen less than `windowMs` after the first of
 * them: a batch of review comments, or quick follow-ups. Oldest first by event time; a window of 0 folds nothing.
 */
export function coalesceWakes(pending: readonly PendingWake[], windowMs: number): CoalescedWake[] {
  const out: CoalescedWake[] = [];
  const open = new Map<string, CoalescedWake>();
  for (const p of pending.toSorted((a, b) => a.at.localeCompare(b.at))) {
    const key = keyOf(p);
    const group = open.get(key);
    if (group && Date.parse(p.at) - Date.parse(group.at) < windowMs) {
      group.instructions = addNew(group.instructions, p.wake.instruction);
      group.feedback = [...group.feedback, ...p.wake.feedback];
      group.policies = addNew(group.policies, p.wake.policy);
      group.events = [...group.events, p.eventId];
      continue;
    }

    const next: CoalescedWake = {
      person: p.wake.person,
      subject: p.wake.subject,
      kind: p.wake.kind,
      instructions: [p.wake.instruction],
      feedback: [...p.wake.feedback],
      policies: [p.wake.policy],
      events: [p.eventId],
      at: p.at,
    };

    open.set(key, next);
    out.push(next);
  }

  return out;
}
