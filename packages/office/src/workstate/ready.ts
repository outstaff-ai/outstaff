import type { CanonicalStatus, Issue } from "@outstaff/core";
import type { Pickup, WorkstateCore } from "./core.types.js";
import type { ReadyTicket, TicketRecord } from "./types.js";

/** Items that do not count as working on a ticket: answering a question on it, trying to unblock it. */
const NOT_WORK = new Set(["asked", "unblock"]);
const OPEN = new Set(["queued", "active", "waiting", "blocked"]);

export const pickupKey = (person: string, ticket: string): string => `${person}\n${ticket}`;

/**
 * When the ticket entered `status`: kept while the status stays, else `at`, when the change happened. A move restarts
 * it even when the status looks unchanged (the ticket left and came back between two reads), but never back in time.
 */
export function statusSince(
  prev: TicketRecord | undefined,
  status: CanonicalStatus | undefined,
  at: string,
  moved = false,
): Pick<TicketRecord, "statusSince"> {
  if (!status) {
    return {};
  }

  const kept = prev?.status === status ? prev.statusSince : undefined;
  if (!kept) {
    return { statusSince: at };
  }

  return { statusSince: moved && Date.parse(at) > Date.parse(kept) ? at : kept };
}

/** The fields a ticket takes from the tracker beyond its status: its priority, when the adapter has one. */
export const priorityOf = (issue: Issue): Pick<TicketRecord, "priority"> =>
  issue.priority === undefined ? {} : { priority: issue.priority };

/** Adds one work item to the person's work on its ticket. */
export function addPickup(
  pickups: Map<string, Pickup>,
  item: { person: string; kind: string; status: string; createdAt: string },
  ticket: string,
): void {
  if (NOT_WORK.has(item.kind) || item.status === "canceled") {
    return;
  }

  const key = pickupKey(item.person, ticket);
  const seen = pickups.get(key);
  pickups.set(key, {
    open: (seen?.open ?? false) || OPEN.has(item.status),
    at: seen && Date.parse(seen.at) > Date.parse(item.createdAt) ? seen.at : item.createdAt,
  });
}

/** The person worked on the ticket since it entered its status, or still has work open on it. */
function pickedUp(core: WorkstateCore, person: string, t: TicketRecord): boolean {
  const work = core.pickups.get(pickupKey(person, t.key));
  if (!work) {
    return false;
  }

  return work.open || !t.statusSince || Date.parse(work.at) >= Date.parse(t.statusSince);
}

const readyFor = (person: string, t: TicketRecord): boolean =>
  t.status === "ready" && !t.goneAt && t.assignee?.kind === "agent" && t.assignee.id === person;

/** The ready tickets assigned to the person that it has not picked up yet, in no particular order. */
export function readyTickets(core: WorkstateCore, person: string): ReadyTicket[] {
  return [...core.tickets.values()]
    .filter((t) => readyFor(person, t) && !pickedUp(core, person, t))
    .map((t) => ({
      key: t.key,
      title: t.title,
      readyAt: t.statusSince ?? t.updatedAt,
      ...(t.priority === undefined ? {} : { priority: t.priority }),
    }));
}
