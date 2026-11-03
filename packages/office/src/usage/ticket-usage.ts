import type { TicketUsage, UsageTotals } from "@outstaff/protocol";
import type { TicketUsageDeps } from "./ticket-usage.types.js";
import { addTotals, groupTotals, totalsOf } from "./totals.js";

/** How deep sub-tickets of sub-tickets are rolled up. */
const MAX_DEPTH = 3;

/** The usage of the ticket's own runs: every run of every work item whose subject or references name it. */
async function ownRows(deps: TicketUsageDeps, ticket: string) {
  const items = await deps.store.itemsOfTicket(ticket);
  return items.length === 0 ? [] : deps.store.listRunUsage({ workItemIds: items });
}

/** The ticket's sub-tickets, as the tracker lists them; none when it cannot say. */
async function subTicketsOf(deps: TicketUsageDeps, ticket: string): Promise<string[]> {
  if (!deps.tracker) {
    return [];
  }

  try {
    return (await deps.tracker.listIssues({ parent: ticket, brief: true })).map((i) => i.key);
  } catch (err) {
    deps.log.warn("could not list the sub-tickets of a ticket", { ticket, error: String(err) });
    return [];
  }
}

/** The ticket's own usage plus its sub-tickets' totals, to `depth` levels; a ticket is counted once. */
async function rolledUp(
  deps: TicketUsageDeps,
  ticket: string,
  depth: number,
  seen: Set<string>,
): Promise<{ total: UsageTotals; subTickets: { ticket: string; total: UsageTotals }[] }> {
  seen.add(ticket);
  let total = totalsOf(await ownRows(deps, ticket));
  const subTickets: { ticket: string; total: UsageTotals }[] = [];
  const children = depth < MAX_DEPTH ? await subTicketsOf(deps, ticket) : [];
  for (const child of children.filter((c) => !seen.has(c))) {
    const sub = await rolledUp(deps, child, depth + 1, seen);
    subTickets.push({ ticket: child, total: sub.total });
    total = addTotals(total, sub.total);
  }

  return { total, subTickets };
}

/** A ticket's usage: its own runs broken down by person, model and kind of round, and its rolled-up total. */
export async function ticketUsage(deps: TicketUsageDeps, ticket: string): Promise<TicketUsage> {
  const rows = await ownRows(deps, ticket);
  const { total, subTickets } = await rolledUp(deps, ticket, 0, new Set());
  return {
    ticket,
    own: totalsOf(rows),
    total,
    subTickets,
    byPerson: groupTotals(rows, (r) => r.person),
    byModel: groupTotals(rows, (r) => r.model),
    byKind: groupTotals(rows, (r) => r.kind),
  };
}
