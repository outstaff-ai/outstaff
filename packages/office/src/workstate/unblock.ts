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

/** A close by an untrusted human stops and unblocks nothing: the pipeline records the events and drops them. */
const untrusted = (c: Closing) => (c.event?.data["untrusted"] === true ? { untrusted: true } : {});

const closedBy = (c: Closing) => {
  const closer = closerOf(c);
  return closer ? { closedBy: { ...closer } } : {};
};

/** When the ticket closed: when it entered its status, else when it was last read. */
const closedAt = (rec: TicketRecord) => rec.statusSince ?? rec.updatedAt;

/**
 * Re-reads a ticket. When that finds it just closed, it raises `ticket.closed` on it, naming who closed it, and each
 * ticket it blocks is read again: each one in the blocked status that nothing else blocks any more gets one
 * `ticket.unblocked`, naming the ticket that closed. Each is raised once per closing.
 */
export function createUnblock(core: WorkstateCore, ticketOps: TicketOps): UnblockOps {
  const { store, clock, tickets, logger } = core;
  const { refreshTicket } = ticketOps;

  /**
   * The parent the ticket shares with its blocker, and that parent's agent, read again: a sibling's close also wakes
   * the agent on the parent (`unblocked_to_ready` leaves the wake to that).
   */
  const sharedParent = async (rec: TicketRecord, blocker: TicketRecord) => {
    if (!rec.parent || rec.parent !== blocker.parent) {
      return {};
    }

    await refreshTicket(rec.parent);
    const assignee = tickets.get(rec.parent)?.assignee;
    return {
      parent: rec.parent,
      ...(assignee?.kind === "agent" ? { parentAgent: assignee.id } : {}),
    };
  };

  const raise = async (ctx: RefreshCtx, rec: TicketRecord, blocker: TicketRecord, c: Closing) => {
    const event: WorkflowEvent = {
      type: "ticket.unblocked",
      subject: { ticket: rec.key },
      actor: { ...WORKSTATE_ACTOR },
      data: {
        blocker: blocker.key,
        blockerTitle: blocker.title,
        ...(await sharedParent(rec, blocker)),
        ...closedBy(c),
        ...untrusted(c),
        at: clock.now().toISOString(),
      },
    };

    await recordSynthetic(
      store,
      ctx,
      event,
      `ticket.unblocked:${rec.key}:${blocker.key}:${closedAt(blocker)}`,
    );

    logger.info(
      `workstate: ticket.unblocked on ${rec.key}, its last blocker ${blocker.key} closed`,
    );
  };

  const raiseClosed = async (ctx: RefreshCtx, rec: TicketRecord, c: Closing) => {
    const event: WorkflowEvent = {
      type: "ticket.closed",
      subject: { ticket: rec.key },
      actor: { ...WORKSTATE_ACTOR },
      data: { status: rec.status, ...closedBy(c), ...untrusted(c), at: closedAt(rec) },
    };

    await recordSynthetic(store, ctx, event, `ticket.closed:${rec.key}:${closedAt(rec)}`);
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
        await raiseClosed(ctx, rec!, closing);
        await unblockDependents(ctx, rec!, closing);
      }
    },
  };
}
