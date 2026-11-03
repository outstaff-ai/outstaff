import { itemTicket } from "./item-ticket.js";
import type { ItemRef, Store, WorkItem } from "./store/types.js";
import type { PrRecord, WorkState } from "./workstate/index.js";

const CLOSED = new Set(["done", "canceled"]);

type Reader = Pick<Store, "listRuns" | "listItemRefs" | "getSubject">;
type TicketReader = Pick<WorkState, "ticket" | "prsOfTicket" | "refreshTicket">;

/** Whether a pull request leaves something to review: open and not a draft, or merged. */
const reviewable = (pr: PrRecord | undefined): pr is PrRecord =>
  pr !== undefined && ((pr.state === "open" && !pr.draft) || pr.state === "merged");

/** Pull requests and documents the office learned of since the run started: what the agent made or linked in it. */
const addedSince = (refs: ItemRef[], start: string | undefined) =>
  start === undefined
    ? []
    : refs
        .filter((r) => (r.type === "pr" || r.type === "doc") && r.addedAt >= start)
        .map((r) => `${r.type} ${r.ref} added in the run`);

/** Whether the ticket is closed or canceled, or went to review during the run (the agent moved it there). */
const handedOn = (status: string, since: string | undefined, start: string | undefined) =>
  CLOSED.has(status) ||
  (status === "review" && since !== undefined && start !== undefined && since >= start);

/**
 * The ticket closed, canceled or moved to review in the run, read again first: the agent may have moved it after the
 * tracker was last polled.
 */
async function handedOnTicket(
  workState: TicketReader,
  ticket: string,
  run: { person: string; start: string | undefined },
): Promise<string[]> {
  // The agent's hand-back is what the ticket is read for, so a ticket found closed names it as the closer.
  await workState.refreshTicket(ticket, { kind: "agent", id: run.person }).catch(() => undefined);
  const record = workState.ticket(ticket);
  return record?.status && handedOn(record.status, record.statusSince, run.start)
    ? [`${ticket} is ${record.status}`]
    : [];
}

/**
 * What the office sees left to review by an item's run, for a `done` hand-back that does not say (an older agent): a
 * pull request of the item is open for review or merged, one was added to it or a document was linked to it during
 * the run, or its ticket is closed or canceled, or went to review during the run. Empty means nothing.
 */
export function officeToReview(deps: { store: Reader; workState: TicketReader }) {
  const { store, workState } = deps;
  const prOf = async (ref: string) =>
    (await store.getSubject("pr", ref))?.data as PrRecord | undefined;

  /** The pull requests of the item: those it refers to, and those of its ticket. */
  const prsOf = async (refs: ItemRef[], ticket: string | undefined) => [
    ...(await Promise.all(refs.filter((r) => r.type === "pr").map((r) => prOf(r.ref)))),
    ...(ticket ? workState.prsOfTicket(ticket) : []),
  ];

  return async (item: WorkItem): Promise<string[]> => {
    const refs = await store.listItemRefs(item.id);
    const start = (await store.listRuns(item.id)).at(-1)?.startedAt;
    const ticket = await itemTicket(store, item);
    const open = (await prsOf(refs, ticket))
      .filter(reviewable)
      .map((p) => `pull request ${p.title} is ${p.state}`);

    return [
      ...addedSince(refs, start),
      ...(ticket ? await handedOnTicket(workState, ticket, { person: item.person, start }) : []),
      ...open,
    ];
  };
}
