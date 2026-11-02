import type { WorkflowEvent } from "@outstaff/core";
import type { Closing, RefreshCtx, TicketOps, UnblockOps, WorkstateCore } from "./core.types.js";
import { isTerminal } from "./derive.js";
import { recordSynthetic, WORKSTATE_ACTOR } from "./synthetic.js";
import type { TicketRecord } from "./types.js";

type Actor = WorkflowEvent["actor"];

/** The ticket was open when last read and is done or canceled now. A ticket first seen closed was not just closed. */
const closedNow = (prev: TicketRecord | undefined, rec: TicketRecord | undefined) =>
  prev !== undefined && !prev.goneAt && !isTerminal(prev.status) && isTerminal(rec?.status);

/** A blocked ticket none of whose blockers is still open. */
const nothingBlocks = (rec: TicketRecord | undefined): rec is TicketRecord =>
  rec !== undefined &&
  !rec.goneAt &&
  rec.status === "blocked" &&
  (rec.blockedBy ?? []).every((b) => isTerminal(b.status));

/** Who closed the ticket: the actor of the move that closed it, else who the caller says changed it. */
function closerOf(closing: Closing): Actor | undefined {
  const { event, by } = closing;
  return event?.type === "ticket.moved" ? event.actor : by;
}

/**
 * Re-reads a ticket. When that finds it just closed, each ticket it blocks is read again, and each one in the blocked
 * status that nothing else blocks any more gets one `ticket.unblocked`, naming the ticket that closed.
 */
export function createUnblock(core: WorkstateCore, ticketOps: TicketOps): UnblockOps {
  const { store, clock, tickets } = core;
  const { refreshTicket } = ticketOps;

  const raise = async (ctx: RefreshCtx, rec: TicketRecord, blocker: TicketRecord, c: Closing) => {
    const closer = closerOf(c);
    const event: WorkflowEvent = {
      type: "ticket.unblocked",
      subject: { ticket: rec.key },
      actor: { ...WORKSTATE_ACTOR },
      data: {
        blocker: blocker.key,
        blockerTitle: blocker.title,
        ...(closer ? { closedBy: { ...closer } } : {}),
        // A close by an untrusted human unblocks nothing: the pipeline records the event and drops it.
        ...(c.event?.data["untrusted"] === true ? { untrusted: true } : {}),
        at: clock.now().toISOString(),
      },
    };

    const once = blocker.statusSince ?? blocker.updatedAt;
    await recordSynthetic(store, ctx, event, `ticket.unblocked:${rec.key}:${blocker.key}:${once}`);
  };

  const unblockDependents = async (ctx: RefreshCtx, blocker: TicketRecord, c: Closing) => {
    for (const key of blocker.blocks ?? []) {
      await refreshTicket(key);
      const rec = tickets.get(key);
      if (nothingBlocks(rec)) {
        await raise(ctx, rec, blocker, c);
      }
    }
  };

  return {
    async refreshAndUnblock(ctx, key, closing = {}) {
      const prev = tickets.get(key);
      await refreshTicket(key, closing.event);
      const rec = tickets.get(key);
      if (core.tracker && closedNow(prev, rec)) {
        await unblockDependents(ctx, rec!, closing);
      }
    },
  };
}
