import { SILENT_KINDS } from "@outstaff/core";
import { officeToReview } from "./hand-back-review.js";
import { officeWaitingOn } from "./hand-back-waiting.js";
import { itemTicket } from "./item-ticket.js";
import type { WorkItem } from "./store/types.js";
import type { HandBackResult, WorkSourceOptions } from "./work-source.types.js";

/**
 * A `done` hand-back from an agent that did not check what it leaves to review (an older one), when the office sees
 * nothing to review either, must not send the ticket to review with nothing in it: it is taken as a silent finish for
 * a kind that may finish silently, and as `blocked` for any other.
 */
async function checkedDone(
  opts: WorkSourceOptions & { workState: NonNullable<WorkSourceOptions["workState"]> },
  item: WorkItem,
  result: HandBackResult,
): Promise<HandBackResult> {
  const { workState, store } = opts;
  if ((await officeToReview({ store, workState })(item)).length > 0) {
    return result;
  }

  const status = SILENT_KINDS.includes(item.kind) ? "silent" : "blocked";
  opts.logger?.warn(`a done hand-back left nothing to review; taking it as ${status}`, {
    item: item.id,
    person: item.person,
  });

  return { ...result, status };
}

/**
 * Waiting on work in flight is not blocked. A `blocked` hand-back on a ticket whose open work is all in flight (its
 * pull requests open for a human's review, its sub-tickets in review or with an agent) is taken as `silent`: no PM is
 * woken and no human is told again of what they already have. A `silent` one on ticket work, which may finish silently
 * only so, is taken as `blocked` when the ticket waits on nothing.
 */
async function checkedWaiting(
  opts: WorkSourceOptions & { workState: NonNullable<WorkSourceOptions["workState"]> },
  item: WorkItem,
  result: HandBackResult,
): Promise<HandBackResult> {
  const { workState, store } = opts;
  const waitingOn = await officeWaitingOn({ store, workState })(item);
  const fields = { item: item.id, person: item.person };
  if (waitingOn.length > 0) {
    opts.logger?.warn(
      `a ${result.status} hand-back waits on work in flight (${waitingOn.join("; ")}); taking it as silent`,
      fields,
    );

    return { ...result, status: "silent", waitingOn };
  }

  if (result.status === "silent") {
    opts.logger?.warn(
      "a silent hand-back of ticket work waits on nothing in flight; taking it as blocked",
      fields,
    );

    return { ...result, status: "blocked" };
  }

  return result;
}

/**
 * A ticket in backlog is planned for later, not started, so nothing on it is blocked: a `blocked` hand-back on it (a
 * round answering a comment on it, say) is taken as `silent`, and no PM or human is pulled in. The ticket is read
 * again first, as a human may have moved it on during the round.
 */
async function checkedBacklog(
  opts: WorkSourceOptions & { workState: NonNullable<WorkSourceOptions["workState"]> },
  item: WorkItem,
  result: HandBackResult,
): Promise<HandBackResult> {
  const { workState, store } = opts;
  const ticket = await itemTicket(store, item);
  if (!ticket) {
    return result;
  }

  await workState.refreshTicket(ticket, { kind: "agent", id: item.person }).catch(() => undefined);
  if (workState.ticket(ticket)?.status !== "backlog") {
    return result;
  }

  opts.logger?.warn(`a blocked hand-back on ${ticket}, which is in backlog; taking it as silent`, {
    item: item.id,
    person: item.person,
  });

  return { ...result, status: "silent" };
}

/** The status as the office takes it, before the backlog check. */
function checkedStatus(
  opts: WorkSourceOptions & { workState: NonNullable<WorkSourceOptions["workState"]> },
  item: WorkItem,
  result: HandBackResult,
): Promise<HandBackResult> | HandBackResult {
  if (result.status === "done" && !result.toReview) {
    return checkedDone(opts, item, result);
  }

  const ticketSilent = result.status === "silent" && !SILENT_KINDS.includes(item.kind);
  return result.status === "blocked" || ticketSilent ? checkedWaiting(opts, item, result) : result;
}

/** The hand-back as the office takes it, checked against its own view of the item's ticket. */
export async function checkedResult(
  opts: WorkSourceOptions,
  item: WorkItem,
  result: HandBackResult,
): Promise<HandBackResult> {
  const { workState } = opts;
  if (!workState) {
    return result;
  }

  const taken = await checkedStatus({ ...opts, workState }, item, result);
  return taken.status === "blocked" ? checkedBacklog({ ...opts, workState }, item, taken) : taken;
}
