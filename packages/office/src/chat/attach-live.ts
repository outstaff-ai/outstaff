import { CHAT_KIND } from "#/scheduler/policy.js";
import type { Store, WorkItem } from "#/store/types.js";
import type { PrRecord } from "#/workstate/index.js";

/** Work that is still open, the order an attached request prefers it in. */
const LIVE: WorkItem["status"][] = ["active", "queued", "waiting", "blocked"];

/** The ticket of the pull request an item is about, as the work state recorded it. */
async function prTicket(store: Pick<Store, "getSubject">, item: WorkItem) {
  if (item.subject?.type !== "pr") {
    return undefined;
  }

  return ((await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined)?.ticket;
}

/**
 * Whether the item works on the attached work: its pull request, its ticket, or another pull request of that ticket,
 * such as a merged one whose merge checks failed (the round fixing them is the ticket's work).
 */
async function worksOn(
  store: Pick<Store, "getSubject">,
  item: WorkItem,
  subject: { type: string; ref: string },
  key: string | undefined,
) {
  if (item.subject?.type === "pr" && item.subject.ref === subject.ref) {
    return true;
  }

  if (key === undefined) {
    return false;
  }

  return item.subject?.type === "ticket"
    ? item.subject.ref === key
    : (await prTicket(store, item)) === key;
}

/** The person's open items, other than chat sessions, that work on the attached work, the running one first. */
export async function liveWorkOn(
  store: Pick<Store, "getSubject" | "listItems">,
  person: string,
  subject: { type: string; ref: string },
  key: string | undefined,
): Promise<WorkItem[]> {
  const open = (await store.listItems({ person })).filter(
    (i) => LIVE.includes(i.status) && i.kind !== CHAT_KIND,
  );

  const found: WorkItem[] = [];
  for (const i of open) {
    if (await worksOn(store, i, subject, key)) {
      found.push(i);
    }
  }

  return found.toSorted((a, b) => LIVE.indexOf(a.status) - LIVE.indexOf(b.status));
}
