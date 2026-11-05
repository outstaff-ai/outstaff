import type { Notify } from "#/pipeline/decisions.types.js";
import { recentSent } from "./book.js";
import type {
  NoticeBook,
  NoticeEntry,
  NoticeGroup,
  NoticeThread,
  PendingNotices,
} from "./notify.types.js";

/** The keys of what a group tells the human: its ticket's need, and each pull request. */
export const keysOf = (human: string, g: Pick<NoticeGroup, "ticket" | "need" | "prs">) => [
  ...(g.ticket ? [`${human}|${g.ticket}|${g.need}`] : []),
  ...g.prs.map((p) => `${human}|${p.ref}`),
];

const sameHands = (p: PendingNotices, n: Notify) => p.as === n.as && p.human === n.human;

/** A notice that says the human was told elsewhere: what was held for its ticket goes, and is not sent later. */
function told(b: NoticeBook, n: Notify, at: string): NoticeBook {
  const pending = b.pending.flatMap((p) => {
    if (!sameHands(p, n)) {
      return [p];
    }

    const entries = p.entries.filter((e) => e.ticket !== n.ticket);
    return entries.length > 0 ? [{ ...p, entries }] : [];
  });

  const keys = keysOf(n.human, { ...n, prs: n.prs ?? [] });
  return { pending, sent: [...b.sent, ...keys.map((key) => ({ key, at }))] };
}

/** What the desk holds of a notice, until it is sent. */
const entryOf = (n: Notify, eventId: string, at: string, thread?: NoticeThread): NoticeEntry => ({
  event: eventId,
  at,
  need: n.need,
  ...(n.ticket ? { ticket: n.ticket } : {}),
  prs: n.prs ?? [],
  ...(n.text ? { text: n.text } : {}),
  ...(thread ? { thread } : {}),
});

/**
 * The book with the notice an event decided: joined to what the human holds from the same agent, else held on its own.
 * The same event delivered again changes nothing; one event may tell the human about several tickets, one notice each.
 * `thread` is the chat thread the notice goes to instead of a direct message.
 */
export function holdNotice(
  b: NoticeBook,
  n: Notify,
  eventId: string,
  at: string,
  thread?: NoticeThread,
): NoticeBook {
  const key = `event:${eventId}|${n.as}|${n.human}|${n.ticket ?? ""}`;
  if (recentSent(b, Date.parse(at)).some((s) => s.key === key)) {
    return b;
  }

  const marked = { ...b, sent: [...b.sent, { key, at }] };
  if (n.told) {
    return told(marked, n, at);
  }

  const entry = entryOf(n, eventId, at, thread);
  const mine = b.pending.find((p) => sameHands(p, n));
  const pending = mine
    ? b.pending.map((p) => (p === mine ? { ...p, last: at, entries: [...p.entries, entry] } : p))
    : [...b.pending, { as: n.as, human: n.human, first: at, last: at, entries: [entry] }];

  return { ...marked, pending };
}
