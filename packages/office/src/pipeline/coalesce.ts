import { MERGE_KIND } from "#/scheduler/policy.js";
import type { CoalescedWake, PendingWake } from "./coalesce.types.js";

/**
 * What wakes fold together by: the person and the subject, whatever the kind, except that a merge keeps a run of its
 * own, with its own context and its place in the repository's one-merge-at-a-time line.
 */
export const coalesceKey = (
  person: string,
  subject: { type: string; ref: string },
  kind: string,
): string =>
  JSON.stringify([person, subject.type, subject.ref, ...(kind === MERGE_KIND ? [kind] : [])]);

const keyOf = (w: PendingWake) => coalesceKey(w.wake.person, w.wake.subject, w.wake.kind);

const addNew = <T>(list: T[], item: T) => (list.includes(item) ? list : [...list, item]);

/**
 * Folds wakes for the same person and subject into one run (a merge only with a merge), as the scheduler does: a wake with a window joins the run of
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
