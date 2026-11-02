import type { ReviewThread } from "@outstaff/core";
import type { GraphReview, GraphTicket } from "#/pipeline/context/index.js";
import type { ItemRef } from "#/store/types.js";
import { isOpen } from "#/workstate/open.js";
import type { PrRecord } from "#/workstate/index.js";
import type { ContextReaders, ThreadsRead } from "./types.js";

/** Where the review threads of a finished pull request are kept, so the code host is read for them once. */
export const PR_THREADS_SUBJECT = "pr_threads";

interface KeptThreads {
  /** The pull request record's `updatedAt` when they were read: a later event reads them again. */
  updatedAt: string;
  threads: ReviewThread[];
}

const record = async (r: ContextReaders, key: string) =>
  (await r.store.getSubject("pr", key))?.data as PrRecord | undefined;

/** Best effort: the bundle goes out without what the code host could not answer. */
async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * The review threads of a pull request, each read from the code host at most once per wake. An open one is read now;
 * a finished one is kept in the store and read again only after an event changes its record.
 */
export function threadsReader(r: ContextReaders): ThreadsRead {
  const reads = new Map<string, Promise<ReviewThread[] | undefined>>();
  const read = async (key: string, rec: PrRecord) => {
    const vcs = r.vcs;
    if (!vcs) {
      return undefined;
    }

    if (isOpen(rec)) {
      return attempt(() => vcs.reviewThreads(rec.ref.repo, rec.ref.number));
    }

    const kept = (await r.store.getSubject(PR_THREADS_SUBJECT, key))?.data as
      | KeptThreads
      | undefined;

    if (kept?.updatedAt === rec.updatedAt) {
      return kept.threads;
    }

    const threads = await attempt(() => vcs.reviewThreads(rec.ref.repo, rec.ref.number));
    if (threads) {
      await r.store.upsertSubject(PR_THREADS_SUBJECT, key, {
        updatedAt: rec.updatedAt,
        threads,
      } satisfies KeptThreads);
    }

    return threads;
  };

  return (key, rec) => {
    const found = reads.get(key) ?? read(key, rec);
    reads.set(key, found);
    return found;
  };
}

/** The comments of a thread that go in: all of a thread a human opened, else only the human ones. */
function shownOf(thread: ReviewThread) {
  return thread.comments[0]?.kind === "human"
    ? thread.comments
    : thread.comments.filter((c) => c.kind === "human");
}

function reviewsOf(key: string, rec: PrRecord, threads: ReviewThread[]): GraphReview[] {
  return threads.flatMap((t) =>
    shownOf(t).map((c) => ({
      pr: key,
      ticket: rec.ticket,
      resolved: t.resolved,
      path: t.path,
      line: t.line,
      url: c.url,
      author: c.author,
      at: c.at,
      body: c.body,
    })),
  );
}

/** The review comments on a ticket's pull requests, open and merged; a closed one that did not merge is left out. */
async function ticketReviews(
  r: ContextReaders,
  threads: ThreadsRead,
  ticket: string,
): Promise<GraphReview[]> {
  const links = await r.store.queryLinks({
    to: { type: "ticket", ref: ticket },
    relation: "implements",
  });

  const out: GraphReview[] = [];
  for (const key of new Set(links.map((l) => l.from.ref))) {
    const rec = await record(r, key);
    const found = rec && rec.state !== "closed" && !rec.goneAt && (await threads(key, rec));
    out.push(...(found ? reviewsOf(key, rec, found) : []));
  }

  return out;
}

/** The tickets the work is on: its own ticket references, and the tickets of its own pull requests. */
async function workTickets(r: ContextReaders, refs: ItemRef[]): Promise<Set<string>> {
  const keys = new Set(refs.filter((x) => x.type === "ticket").map((x) => x.ref));
  for (const x of refs.filter((y) => y.type === "pr")) {
    const ticket = (await record(r, x.ref))?.ticket;
    if (ticket) {
      keys.add(ticket);
    }
  }

  return keys;
}

/**
 * The tickets of the graph with, on each the work is on, the review comments on its pull requests and on its
 * parent's: what a review decided stays in the context after its thread is resolved or the pull request merges.
 */
export async function withReviews(
  r: ContextReaders,
  threads: ThreadsRead,
  refs: ItemRef[],
  tickets: GraphTicket[],
): Promise<GraphTicket[]> {
  const work = await workTickets(r, refs);
  const out: GraphTicket[] = [];
  for (const t of tickets) {
    if (!work.has(t.key)) {
      out.push(t);
      continue;
    }

    const keys = [t.key, ...(t.parent && t.parent !== t.key ? [t.parent] : [])];
    const reviews = (await Promise.all(keys.map((k) => ticketReviews(r, threads, k)))).flat();
    out.push({ ...t, reviews });
  }

  return out;
}
