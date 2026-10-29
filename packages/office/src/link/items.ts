import type { LinkItemSummary, LinkResultOf } from "@outstaff/protocol";
import type { WakeReason } from "#/pipeline/live/live.types.js";
import { WAKE_SUBJECT } from "#/pipeline/live/wake.js";
import type { WorkItem } from "#/store/types.js";
import type { ItemFilter, LinkStore } from "./link.types.js";

/** The pipeline policy and event that queued an item, when the live pipeline did. */
export async function scheduledBy(store: Pick<LinkStore, "getSubject">, id: string) {
  const reason = (await store.getSubject(WAKE_SUBJECT, id))?.data as WakeReason | undefined;
  return reason ? { policy: reason.policy, eventId: reason.event } : null;
}

/** A work item without its runs and journal. */
export const summary = async (
  store: Pick<LinkStore, "getSubject">,
  i: WorkItem,
): Promise<LinkItemSummary> => ({
  id: i.id,
  kind: i.kind,
  title: i.title,
  subject: i.subject,
  person: i.person,
  status: i.status,
  priority: i.priority,
  trigger: i.trigger,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
  scheduledBy: await scheduledBy(store, i.id),
});

/** Work items newest first, by when they were created; `before` is the time cursor of the next page. */
export async function findItems(store: LinkStore, f: ItemFilter): Promise<LinkResultOf<"items">> {
  const limit = f.limit ?? 50;
  const matching = await store.listItems({
    ...(f.person ? { person: f.person } : {}),
    ...(f.status ? { status: f.status } : {}),
  });

  const all = matching
    .filter((i) => f.before === undefined || i.createdAt < f.before)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

  // A page never ends in the middle of the items of one time, so `before` = `nextBefore` misses none.
  const cut = all.slice(0, limit).at(-1)?.createdAt;
  const page = all.filter((i, n) => n < limit || i.createdAt === cut);
  const items = await Promise.all(page.map((i) => summary(store, i)));
  const total = matching.length;
  return page.length < all.length ? { items, total, nextBefore: cut! } : { items, total };
}
