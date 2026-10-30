import type { CoalescedWake, PendingWake } from "./coalesce.types.js";

const keyOf = (w: PendingWake) =>
  JSON.stringify([w.wake.person, w.wake.subject.type, w.wake.subject.ref]);

const addNew = <T>(list: T[], item: T) => (list.includes(item) ? list : [...list, item]);

/**
 * Folds wakes for the same person and subject into one run, as the scheduler does: a wake with a window joins the run of
 * the first, while that one's window (`coalesceMs`) is open. A batch of review comments, or quick follow-ups. Oldest
 * first by event time; a wake with no window, a chat message's, folds into nothing and opens none.
 */
export function coalesceWakes(pending: readonly PendingWake[]): CoalescedWake[] {
  const out: CoalescedWake[] = [];
  const open = new Map<string, { group: CoalescedWake; until: number }>();
  for (const p of pending.toSorted((a, b) => a.at.localeCompare(b.at))) {
    const key = keyOf(p);
    const window = open.get(key);
    if (window && p.wake.coalesceMs > 0 && Date.parse(p.at) < window.until) {
      const { group } = window;
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

    if (p.wake.coalesceMs > 0) {
      open.set(key, { group: next, until: Date.parse(p.at) + p.wake.coalesceMs });
    }

    out.push(next);
  }

  return out;
}
