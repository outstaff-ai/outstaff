import type { Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/index.js";
import type { ChatOrigin } from "@outstaff/protocol";
import { readOrigin, threadsOf } from "./origin.js";

type TieStore = Pick<Store, "findItemRefs" | "getItem" | "getSubject">;

/** How far up a work item's parents the walk goes: a chat session, and work filed or attached from it, is two. */
const MAX_DEPTH = 8;

/** The item and its parents, nearest first, while they are the person's. */
async function chainOf(store: TieStore, itemId: string, person: string): Promise<string[]> {
  const out: string[] = [];
  let id: string | null | undefined = itemId;
  while (id && out.length < MAX_DEPTH && !out.includes(id)) {
    const item = await store.getItem(id);
    if (item?.person !== person) {
      break;
    }

    out.push(id);
    id = item.parentId;
  }

  return out;
}

/** The work items on the ticket or its pull requests, besides those that only mentioned it. */
async function itemsOn(
  store: TieStore,
  workState: Pick<WorkState, "prsOfTicket" | "prSubject">,
  ticket: string,
): Promise<string[]> {
  const subjects = [
    { type: "ticket" as const, ref: ticket },
    ...workState
      .prsOfTicket(ticket)
      .map((p) => ({ type: "pr" as const, ref: workState.prSubject(p.ref) })),
  ];

  const refs = await Promise.all(subjects.map((s) => store.findItemRefs(s.type, s.ref)));
  return refs.flat().flatMap((r) => (r.role === "mentioned" ? [] : [r.workItemId]));
}

/** Every thread the item's chat origin reports to; none without one. */
async function threadsOfItem(store: TieStore, itemId: string): Promise<ChatOrigin[]> {
  const origin = await readOrigin(store, itemId);
  return origin ? threadsOf(origin) : [];
}

/**
 * The chat threads with the agent the ticket's work is tied to: those the chat origin of any of the agent's work items
 * on the ticket or its pull requests, or of their parents, reports to. That covers work filed or attached from chat,
 * and its later rounds (review, merge, rebase, CI). A thread that only mentioned the ticket ties nothing. `also` are
 * more of the agent's items to start from. Each thread is where its requester hears of the work, in place of a direct
 * message. Only the agent's own items count: a thread in its direct messages with a human is no place for another
 * agent to post.
 */
export async function chatThreadsOf(
  store: TieStore,
  workState: Pick<WorkState, "prsOfTicket" | "prSubject">,
  person: string,
  ticket: string,
  also: readonly string[] = [],
): Promise<ChatOrigin[]> {
  const items = new Set([...also, ...(await itemsOn(store, workState, ticket))]);
  const walked = new Set<string>();
  for (const itemId of items) {
    for (const id of await chainOf(store, itemId, person)) {
      walked.add(id);
    }
  }

  const threads = (await Promise.all([...walked].map((id) => threadsOfItem(store, id)))).flat();
  return threads.filter(
    (t, i) => threads.findIndex((x) => x.channel === t.channel && x.thread === t.thread) === i,
  );
}
