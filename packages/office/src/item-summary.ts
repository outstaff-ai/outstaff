import type { WorkSummary } from "@outstaff/protocol";
import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord, TicketRecord } from "./workstate/index.js";

/** An item as the protocol lists it. */
export async function summarizeItem(
  store: Store,
  item: WorkItem,
  current?: string,
): Promise<WorkSummary> {
  let ticketKey: string | undefined;
  let pr: PrRecord | undefined;
  if (item.subject?.type === "ticket") {
    ticketKey = item.subject.ref;
  } else if (item.subject?.type === "pr") {
    pr = (await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined;
    ticketKey = pr?.ticket;
  }

  const ticketTitle = ticketKey
    ? ((await store.getSubject("ticket", ticketKey))?.data as TicketRecord | undefined)?.title
    : undefined;

  return {
    id: item.id,
    title: item.title,
    status: item.status,
    kind: item.kind,
    ...(ticketKey ? { ticketKey } : {}),
    ...(ticketTitle ? { ticketTitle } : {}),
    ...(item.subject?.type === "pr" ? { pr: item.subject.ref } : {}),
    ...(pr ? { prNumber: pr.ref.number, prTitle: pr.title } : {}),
    ...(pr?.url ? { prUrl: pr.url } : {}),
    ...(current === item.id ? { current: true } : {}),
  };
}
