import type { WorkSummary } from "@outstaff/protocol";
import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord, TicketRecord } from "./workstate/index.js";

/** The record of the pull request the item is about, if it is about one. */
async function prOf(store: Store, item: WorkItem): Promise<PrRecord | undefined> {
  if (item.subject?.type !== "pr") {
    return undefined;
  }

  return (await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined;
}

/** The item's ticket: its subject, or the ticket of its pull request. */
const ticketKeyOf = (item: WorkItem, pr: PrRecord | undefined) =>
  item.subject?.type === "ticket" ? item.subject.ref : pr?.ticket;

async function ticketTitleOf(store: Store, key: string | undefined) {
  if (!key) {
    return undefined;
  }

  return ((await store.getSubject("ticket", key))?.data as TicketRecord | undefined)?.title;
}

function prFields(item: WorkItem, pr: PrRecord | undefined) {
  return {
    ...(item.subject?.type === "pr" ? { pr: item.subject.ref } : {}),
    ...(pr ? { prNumber: pr.ref.number, prTitle: pr.title } : {}),
    ...(pr?.url ? { prUrl: pr.url } : {}),
  };
}

/** An item as the protocol lists it. */
export async function summarizeItem(
  store: Store,
  item: WorkItem,
  current?: string,
): Promise<WorkSummary> {
  const pr = await prOf(store, item);
  const ticketKey = ticketKeyOf(item, pr);
  const ticketTitle = await ticketTitleOf(store, ticketKey);
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    kind: item.kind,
    ...(ticketKey ? { ticketKey } : {}),
    ...(ticketTitle ? { ticketTitle } : {}),
    ...prFields(item, pr),
    ...(current === item.id ? { current: true } : {}),
  };
}
