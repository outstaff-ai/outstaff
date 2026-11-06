import type { WorkstateCore } from "./core.types.js";
import { recoveryLine } from "./block-nudges.js";
import { isTerminal } from "./derive.js";
import { isOpen } from "./open.js";
import { pickupKey } from "./ready.js";
import type { StaleTicket } from "./stale.types.js";
import type { TicketRecord } from "./types.js";

const HOUR = 60 * 60 * 1000;

/** What a check needs besides the ticket: the work state, the time now and how long a block with a human may sit. */
interface Look {
  core: WorkstateCore;
  now: number;
  staleMs: number;
}

type Finding = Pick<StaleTicket, "reason" | "facts"> | undefined;

const live = (core: WorkstateCore, key: string) =>
  [...core.prs.values()].filter((p) => p.ticket === key && !p.goneAt);

const subTickets = (core: WorkstateCore, key: string) =>
  [...core.tickets.values()].filter((t) => t.parent === key && !t.goneAt);

const hours = (ms: number) => Math.floor(ms / HOUR);

/** In review: its pull requests are all merged or closed, with no merge check pending; or it has none and no human. */
function inReview({ core }: Look, t: TicketRecord): Finding {
  const prs = live(core, t.key);
  if (prs.length === 0) {
    return t.assignee?.kind === "human"
      ? undefined
      : { reason: "nothing_to_review", facts: "it has no pull request and is not with a human" };
  }

  const finished = prs.every((p) => !isOpen(p) && p.mergeChecks?.state !== "pending");
  const list = prs.map((p) => `#${p.ref.number} ${p.state}`).join(", ");
  return finished
    ? { reason: "prs_finished", facts: `its pull requests are all merged or closed: ${list}` }
    : undefined;
}

/** A failed merge of the ticket whose checks passed later on the default branch. */
const recovered = (core: WorkstateCore, key: string) =>
  live(core, key).find((p) => p.mergeChecks?.recoveredOn);

/** Every linked blocker is closed. */
function blockersClosed(t: TicketRecord): Finding {
  const blockers = t.blockedBy ?? [];
  if (blockers.length === 0 || !blockers.every((b) => isTerminal(b.status))) {
    return undefined;
  }

  const list = blockers.map((b) => `${b.key} ${b.status}`).join(", ");
  return { reason: "blockers_closed", facts: `every ticket blocking it is closed: ${list}` };
}

/** With a human, with no change in the tracker for the stale time. */
function idleWithHuman(look: Look, t: TicketRecord): Finding {
  const since = Date.parse(t.changedAt ?? t.statusSince ?? t.updatedAt);
  if (t.assignee?.kind !== "human" || look.now - since < look.staleMs) {
    return undefined;
  }

  return {
    reason: "idle_with_human",
    facts: `it has been with ${t.assignee.id} with no change for ${hours(look.now - since)} hours`,
  };
}

/** Blocked: every blocker is closed; a check that failed after its merge passes now; or it sat with a human. */
function blocked(look: Look, t: TicketRecord): Finding {
  const pr = recovered(look.core, t.key);
  const passed: Finding = pr ? { reason: "check_passed", facts: recoveryLine(pr) } : undefined;
  return blockersClosed(t) ?? passed ?? idleWithHuman(look, t);
}

/** Whether an agent has work open on the ticket (or its parent or a sub-ticket), or finished some within the hour. */
function worked({ core, now }: Look, person: string, keys: string[]): boolean {
  return keys.some((k) => {
    const p = core.pickups.get(pickupKey(person, k));
    return p !== undefined && (p.open || now - Date.parse(p.until) < HOUR);
  });
}

/** Active with an agent: no work queued or running for it, and none finished in the last hour. */
function active(look: Look, t: TicketRecord): Finding {
  const agent = t.assignee?.kind === "agent" ? t.assignee.id : undefined;
  const since = Date.parse(t.statusSince ?? t.updatedAt);
  const keys = [
    t.key,
    ...(t.parent ? [t.parent] : []),
    ...subTickets(look.core, t.key).map((s) => s.key),
  ];

  if (!agent || look.now - since < HOUR || worked(look, agent, keys)) {
    return undefined;
  }

  return {
    reason: "stranded",
    facts: `it is active with ${agent}, with no work queued or running and none finished in the last hour`,
  };
}

/** A parent whose sub-tickets are all closed, or closed or in review, while it is active or blocked. */
function parent({ core }: Look, t: TicketRecord): Finding {
  const subs = subTickets(core, t.key);
  const settled = (s: TicketRecord) => isTerminal(s.status) || s.status === "review";
  if (
    subs.length === 0 ||
    !subs.every(settled) ||
    (t.status !== "active" && t.status !== "blocked")
  ) {
    return undefined;
  }

  const list = subs.map((s) => `${s.key} ${s.status}`).join(", ");
  return {
    reason: "subtickets_settled",
    facts: `its sub-tickets are all closed or in review: ${list}`,
  };
}

const BY_STATUS: Partial<Record<string, (look: Look, t: TicketRecord) => Finding>> = {
  review: inReview,
  blocked,
  active,
};

/**
 * The open tickets in active, review or blocked whose status or assignee no longer matches what the work state knows,
 * each with why and the facts: from its own records, with nothing read.
 */
export function findStale(core: WorkstateCore, now: Date, staleMs: number): StaleTicket[] {
  const look: Look = { core, now: now.getTime(), staleMs };
  const out: StaleTicket[] = [];
  for (const t of core.tickets.values()) {
    const check = t.goneAt ? undefined : BY_STATUS[t.status ?? ""];
    const found = check && (parent(look, t) ?? check(look, t));
    if (found) {
      out.push({
        ticket: t.key,
        status: t.status!,
        ...(t.assignee ? { assignee: t.assignee.id } : {}),
        ...found,
      });
    }
  }

  return out;
}
