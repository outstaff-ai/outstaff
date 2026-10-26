import type { Link } from "@outstaff/protocol";
import type { Store } from "../store/types.js";

/**
 * Reports to a requester that an agent had not posted when its item ended, kept per person until the agent
 * collects them on connecting. The office never posts them: only the agent speaks to people.
 */
export const PENDING_REPORT_SUBJECT = "pending_report";

export interface PendingReport {
  itemId: string;

  /** The claim key of the ending, so a retried hand-back does not queue it twice. */
  key: string;
  kind: "result" | "blocked";
  summary: string;
  links: Link[];
  at: string;
}

interface Book {
  queue: PendingReport[];

  /** The ending reported last for each item, whether the agent posted it itself or collected it from here. */
  reported: Record<string, string>;
}

export interface ReportQueue {
  /** Queues the report unless that ending was reported or is queued already. */
  add(person: string, report: PendingReport): Promise<void>;

  /** What waits for the person, oldest first. */
  list(person: string): Promise<PendingReport[]>;

  /** Whether that ending was reported already (posted by the agent, or handed to it). */
  done(person: string, itemId: string, key: string): Promise<boolean>;

  /** The agent posted (or was handed) the ending of the item: it is not queued any more and never queued again. */
  settle(person: string, itemId: string, key: string): Promise<void>;
}

export function createReportQueue(store: Pick<Store, "getSubject" | "upsertSubject">): ReportQueue {
  // Read, change, write: one at a time, so two hand-backs of one person do not overwrite each other.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const read = async (person: string): Promise<Book> =>
    ((await store.getSubject(PENDING_REPORT_SUBJECT, person))?.data as Book | undefined) ?? {
      queue: [],
      reported: {},
    };

  return {
    add: (person, report) =>
      locked(async () => {
        const book = await read(person);
        if (book.reported[report.itemId] === report.key) {
          return;
        }

        await store.upsertSubject(PENDING_REPORT_SUBJECT, person, {
          ...book,
          queue: [...book.queue.filter((r) => r.itemId !== report.itemId), report],
        });
      }),

    list: async (person) => (await read(person)).queue,

    done: async (person, itemId, key) => (await read(person)).reported[itemId] === key,

    settle: (person, itemId, key) =>
      locked(async () => {
        const book = await read(person);
        await store.upsertSubject(PENDING_REPORT_SUBJECT, person, {
          queue: book.queue.filter((r) => r.itemId !== itemId),
          reported: { ...book.reported, [itemId]: key },
        });
      }),
  };
}
