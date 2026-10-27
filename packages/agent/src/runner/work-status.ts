import type { Tracker } from "@outstaff/core";
import type { Offer } from "#/office-client/index.js";
import { anyBlocked } from "./blocked.js";
import type { WorkerContext } from "./loop.types.js";
import type { HandBackStatus, ItemRun } from "./work.types.js";

const offeredTickets = (offer: Offer) =>
  new Set(offer.context.subjects.filter((x) => x.type === "ticket").map((x) => x.ref));

/** The status the agent last moved one of the item's tickets to (any ticket, when the item names none). */
function lastMovedStatus(moved: Map<string, string>, offered: Set<string>): string | undefined {
  const last = [...moved].filter(([k]) => offered.size === 0 || offered.has(k)).at(-1);

  return last?.[1];
}

/** Whether a ticket of the item that the agent did not move is blocked in the tracker. */
const untouchedBlocked = (
  tracker: Tracker | undefined,
  offered: Set<string>,
  moved: Map<string, string>,
) =>
  anyBlocked(
    tracker,
    [...offered].filter((k) => !moved.has(k)),
  );

/**
 * What a finished run is handed back as. An open question makes it wait. A ticket the agent left blocked, or a ticket
 * that is blocked in the tracker at the end of a run that moved nothing, was not got past: a blocked hand-back,
 * whatever the final message says.
 */
export async function handBackStatus(
  { opts, log }: WorkerContext,
  { offer, item }: ItemRun,
): Promise<HandBackStatus> {
  if (item.asked()) {
    return "waiting";
  }

  const offered = offeredTickets(offer);
  const last = lastMovedStatus(item.moved, offered);
  const workItemId = offer.workItem.id;
  if (last === "blocked") {
    log.warn("the agent left its ticket blocked; handing back as blocked", { workItemId });
    return "blocked";
  }

  if (last === undefined && (await untouchedBlocked(opts.env.tracker, offered, item.moved))) {
    log.warn("the agent left its blocked ticket blocked; handing back as blocked", { workItemId });
    return "blocked";
  }

  return "done";
}
