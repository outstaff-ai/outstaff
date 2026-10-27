import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord } from "./workstate/index.js";

/** The ticket an item is about: its subject, or the ticket of the pull request it is about. */
export async function itemTicket(
  store: Pick<Store, "getSubject">,
  item: Pick<WorkItem, "subject">,
): Promise<string | undefined> {
  const subject = item.subject;
  if (subject?.type === "ticket") {
    return subject.ref;
  }

  if (subject?.type !== "pr") {
    return undefined;
  }

  return ((await store.getSubject("pr", subject.ref))?.data as PrRecord | undefined)?.ticket;
}
