import type { WorkItem } from "#/store/index.js";
import type { TicketWork } from "./core.types.js";
import type { TicketRecord } from "./types.js";

/** Answering a question on a ticket, or trying to unblock it, is not working on it. */
const NOT_WORK = new Set(["asked", "unblock"]);

/** Whether an item of this kind works on its ticket. */
export const worksOnTicket = (kind: string) => !NOT_WORK.has(kind);

const time = (at: string) => Date.parse(at);

/** One agent's item on a ticket, as the rounds and the blocked agent are read from it; none before it is offered. */
export const ticketWork = (item: WorkItem): TicketWork | undefined =>
  item.status === "queued"
    ? undefined
    : {
        person: item.person,
        kind: item.kind,
        status: item.status,
        from: item.createdAt,
        to: item.updatedAt,
      };

/**
 * How far apart the tracker's clock and the office's may be. A round's times are the office's and a comment's time is
 * the tracker's, so a comment this close to a round's start or end is taken as the round's own: a missed wake can be
 * recovered, a loop of agents waking each other cannot.
 */
export const CLOCK_SKEW_MS = 1_000;

/**
 * Whether the agent had a round on the ticket under way at `at`, a time the tracker reported: an active round has not
 * ended yet, and either end is widened by the clock skew.
 */
export function inRound(work: readonly TicketWork[], person: string, at: string): boolean {
  const t = time(at);
  return work.some(
    (w) =>
      w.person === person &&
      time(w.from) - CLOCK_SKEW_MS <= t &&
      (w.status === "active" || t <= time(w.to) + CLOCK_SKEW_MS),
  );
}

/** The work ended as blocked: handed back as blocked, or as done after the agent moved the ticket to blocked. */
function endedBlocked(w: TicketWork, rec: TicketRecord): boolean {
  if (w.status === "blocked") {
    return true;
  }

  const since = rec.statusSince ? time(rec.statusSince) : NaN;
  return w.status === "done" && time(w.from) <= since && since <= time(w.to);
}

/**
 * The agent blocked on a blocked ticket: of each agent's latest work on it, the latest that ended blocked. An unblock
 * round or another agent's round does not change it; the agent working on the ticket again clears it.
 */
export function blockedAgent(
  rec: TicketRecord | undefined,
  work: readonly TicketWork[],
): string | undefined {
  if (rec?.status !== "blocked") {
    return undefined;
  }

  const latest = new Map<string, TicketWork>();
  for (const w of work.filter((x) => worksOnTicket(x.kind))) {
    const seen = latest.get(w.person);
    if (!seen || time(seen.to) < time(w.to)) {
      latest.set(w.person, w);
    }
  }

  return [...latest.values()]
    .filter((w) => endedBlocked(w, rec))
    .toSorted((a, b) => time(b.to) - time(a.to))[0]?.person;
}
