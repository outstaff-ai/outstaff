import type { ContextGraph } from "#/pipeline/context/index.js";
import { neighbourhood } from "./neighbourhood.js";
import { readChat, readDoc, readPr, readTicket } from "./reads.js";
import { threadsReader, withReviews } from "./reviews.js";
import type { ContextReaders } from "./types.js";

async function readAll<T>(
  keys: Set<string>,
  read: (key: string) => Promise<T | undefined>,
): Promise<T[]> {
  const found = await Promise.all([...keys].map(read));
  return found.filter((x) => x !== undefined);
}

/**
 * A snapshot of what the office knows around an item, for the context builder: the item's references, the tickets,
 * pull requests, documents and chat threads around them, and their data, with the review comments on the pull requests
 * of the tickets the work is on and of their parents. Reads at most `max` of each kind. The tickets and pull requests
 * that are `person`'s work, the person the item is for, say so.
 */
export async function gatherGraph(
  readers: ContextReaders,
  itemId: string,
  max: number,
  person?: string,
): Promise<ContextGraph> {
  const { refs, n } = await neighbourhood(readers.store, itemId, max);
  const first = (set: Set<string>) => new Set([...set].slice(0, max));
  const threads = threadsReader(readers);
  const tickets = await readAll(first(n.tickets), (k) => readTicket(readers, k, person));
  return {
    itemId,
    refs,
    tickets: await withReviews(readers, threads, refs, tickets),
    prs: await readAll(first(n.prs), (k) => readPr(readers, k, threads, person)),
    docs: await readAll(first(n.docs), (k) => readDoc(readers, k)),
    chats: await readAll(first(n.chats), (k) => readChat(readers, k)),
    related: n.related,
  };
}
