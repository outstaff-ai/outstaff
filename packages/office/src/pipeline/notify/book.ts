import type { Store } from "#/store/types.js";
import type { NoticeBook } from "./notify.types.js";

/** The notices the office holds, and what it sent lately, in one record of the store. */
export const NOTICE_SUBJECT = "handoff_notices";
const REF = "office";

/** How long a sent notice is remembered: an event delivered again, or a late duplicate, comes well within it. */
export const SENT_KEPT_MS = 60 * 60 * 1000;

/** The book, changed one change at a time: read, change, write. */
export function createNoticeBook(store: Pick<Store, "getSubject" | "upsertSubject">) {
  let chain: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<NoticeBook> =>
    ((await store.getSubject(NOTICE_SUBJECT, REF))?.data as NoticeBook | undefined) ?? {
      pending: [],
      sent: [],
    };

  return {
    read,

    /** Runs the change on the book and writes what it returns; the next change waits for this one. */
    change<T>(fn: (book: NoticeBook) => Promise<{ book: NoticeBook; out: T }>): Promise<T> {
      const run = chain.then(async () => {
        const { book, out } = await fn(await read());
        await store.upsertSubject(NOTICE_SUBJECT, REF, book);
        return out;
      });

      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/** The sent notices still remembered at `now`. */
export const recentSent = (book: NoticeBook, now: number) =>
  book.sent.filter((s) => now - Date.parse(s.at) < SENT_KEPT_MS);
