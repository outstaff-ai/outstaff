import { MERGE_KIND, outranks } from "#/scheduler/policy.js";
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
 * Adds a wake to the run it folds into. A wake that gives the agent the ticket to work on wins over the run's kind
 * (`outranks`): the run takes its kind and its instruction alone, and the others' feedback; a wake the run's kind wins
 * over brings its feedback only. Otherwise the run gains its instruction too.
 */
function fold(group: CoalescedWake, p: PendingWake): void {
  const { wake } = p;
  if (outranks(wake.kind, group.kind)) {
    group.tookOver = group.kind;
    group.kind = wake.kind;
    group.instructions = [wake.instruction];
  } else if (!outranks(group.kind, wake.kind)) {
    group.instructions = addNew(group.instructions, wake.instruction);
  }

  group.feedback = [...group.feedback, ...wake.feedback];
  group.policies = addNew(group.policies, wake.policy);
  group.events = [...group.events, p.eventId];
}

/**
 * Folds wakes for the same person and subject into one run (a merge only with a merge), as the scheduler does: a wake
 * with a window joins the run of the first, while that one's window (`coalesceMs`) is open. A batch of review comments,
 * or quick follow-ups. Oldest first by event time; a wake with no window, a chat message's, folds into nothing and opens
 * none. Which wake wins the run's kind is `fold`'s.
 */
export function coalesceWakes(pending: readonly PendingWake[]): CoalescedWake[] {
  const out: CoalescedWake[] = [];
  const open = new Map<string, { group: CoalescedWake; until: number }>();
  for (const p of pending.toSorted((a, b) => a.at.localeCompare(b.at))) {
    const key = keyOf(p);
    const window = open.get(key);
    if (window && p.wake.coalesceMs > 0 && Date.parse(p.at) < window.until) {
      fold(window.group, p);
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
