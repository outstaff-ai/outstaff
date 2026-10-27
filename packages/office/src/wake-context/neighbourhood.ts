import type { ItemRef, Store } from "#/store/types.js";
import type { DocRecord, PrRecord } from "#/workstate/index.js";
import type { Neighbourhood } from "./types.js";

type Reader = Pick<Store, "getSubject" | "queryLinks" | "findItemRefs" | "listItemRefs">;

const record = async <T>(store: Reader, type: string, ref: string) =>
  (await store.getSubject(type, ref))?.data as T | undefined;

const SETS = { ticket: "tickets", pr: "prs", doc: "docs", chat_thread: "chats" } as const;

function seed(refs: ItemRef[]): Neighbourhood {
  const n: Neighbourhood = {
    tickets: new Set(),
    prs: new Set(),
    docs: new Set(),
    chats: new Set(),
    related: [],
  };

  for (const r of refs) {
    const set = SETS[r.type as keyof typeof SETS];
    if (set) {
      n[set].add(r.ref);
    }
  }

  return n;
}

const size = (n: Neighbourhood) => n.tickets.size + n.prs.size + n.docs.size + n.chats.size;

/** A pull request's ticket, the pull request it is stacked on, and those stacked on it. */
async function aroundPr(store: Reader, n: Neighbourhood, key: string): Promise<void> {
  const rec = await record<PrRecord>(store, "pr", key);
  if (rec?.ticket) {
    n.tickets.add(rec.ticket);
  }

  if (rec?.stackedOn) {
    n.prs.add(rec.stackedOn);
  }

  for (const l of await store.queryLinks({
    to: { type: "pr", ref: key },
    relation: "stacked_on",
  })) {
    n.prs.add(l.from.ref);
  }
}

/** A ticket's pull requests. */
async function aroundTicket(store: Reader, n: Neighbourhood, key: string): Promise<void> {
  const links = await store.queryLinks({
    to: { type: "ticket", ref: key },
    relation: "implements",
  });

  for (const l of links) {
    n.prs.add(l.from.ref);
  }
}

/** A document's ticket. */
async function aroundDoc(store: Reader, n: Neighbourhood, id: string): Promise<void> {
  const ticket = (await record<DocRecord>(store, "doc", id))?.ticket;
  if (ticket) {
    n.tickets.add(ticket);
  }
}

/** The chat threads other work on the same ticket or pull request came from. */
async function relatedChats(store: Reader, n: Neighbourhood, itemId: string): Promise<void> {
  const vias = [
    ...[...n.tickets].map((ref) => ({ type: "ticket" as const, ref })),
    ...[...n.prs].map((ref) => ({ type: "pr" as const, ref })),
  ];

  for (const via of vias) {
    const others = (await store.findItemRefs(via.type, via.ref)).filter(
      (r) => r.workItemId !== itemId,
    );

    for (const other of others) {
      const threads = (await store.listItemRefs(other.workItemId)).filter(
        (r) => r.type === "chat_thread",
      );

      for (const t of threads) {
        n.chats.add(t.ref);
        n.related.push({ via, chat: t.ref, itemId: other.workItemId });
      }
    }
  }
}

/**
 * The tickets, pull requests, documents and chat threads around an item: its own references, then two rounds along
 * the links (a document's ticket, a ticket's pull requests, a pull request's ticket and stack, in that order), then the
 * chat threads that other work on those came from. Stops growing at `max` references.
 */
export async function neighbourhood(
  store: Reader,
  itemId: string,
  max: number,
): Promise<{ refs: ItemRef[]; n: Neighbourhood }> {
  const refs = await store.listItemRefs(itemId);
  const n = seed(refs);
  for (let step = 0; step < 2 && size(n) < max; step++) {
    for (const id of n.docs) {
      await aroundDoc(store, n, id);
    }

    for (const key of n.tickets) {
      await aroundTicket(store, n, key);
    }

    for (const key of n.prs) {
      await aroundPr(store, n, key);
    }
  }

  await relatedChats(store, n, itemId);
  return { refs, n };
}
