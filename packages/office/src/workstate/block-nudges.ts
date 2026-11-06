import { TICKET_KEY, type WorkflowEvent } from "@outstaff/core";
import type { BlockCause, BlockNudges } from "./block-nudges.types.js";
import type { RefreshCtx, WorkstateCore } from "./core.types.js";
import { isTerminal } from "./derive.js";
import { isOpen } from "./open.js";
import { recordSynthetic, WORKSTATE_ACTOR } from "./synthetic.js";
import type { PrRecord, TicketRecord } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NUDGES = "block_nudge";
const ANY_KEY = new RegExp(`\\b(${TICKET_KEY})\\b`, "g");

/** Whether the ticket's work goes on past a merge: another pull request of its is open, or a sub-ticket. */
export function workGoesOn(core: WorkstateCore, key: string): boolean {
  const prs = [...core.prs.values()].some((p) => p.ticket === key && isOpen(p));
  const subs = [...core.tickets.values()].some(
    (t) => t.parent === key && !t.goneAt && !isTerminal(t.status),
  );

  return prs || subs;
}

/** `deploy passes on main at abc1234, which includes #77's merge`. */
export function recoveryLine(rec: PrRecord): string {
  const names = (rec.mergeChecks?.failing ?? []).map((c) => c.name);
  const verb = names.length === 1 ? "passes" : "pass";
  const at = (rec.mergeChecks?.recoveredOn ?? "").slice(0, 7);
  return `${names.join(", ")} ${verb} on ${rec.baseRef} at ${at}, which includes #${rec.ref.number}'s merge`;
}

/** Whether a human the ticket is assigned to is the one who wrote, by any name the tracker knows them by. */
const assignedTo = (rec: TicketRecord, who: string) =>
  rec.assignee?.kind === "human" && [rec.assignee.id, ...(rec.assignee.names ?? [])].includes(who);

/**
 * Raises `ticket.block_maybe_resolved` on a blocked ticket when something it may have waited on happened, so the PM
 * checks whether the block still holds: at most once per ticket and cause in 24 hours, across restarts.
 */
export function createBlockNudges(core: WorkstateCore): BlockNudges {
  const { store, clock, tickets, logger } = core;

  const nudge = async (ctx: RefreshCtx, key: string, cause: BlockCause) => {
    const rec = tickets.get(key);
    if (rec?.status !== "blocked" || rec.goneAt) {
      return;
    }

    const id = `${key}|${cause.kind}:${cause.ref}`;
    const now = clock.now();
    const last = (await store.getSubject(NUDGES, id))?.data as { at?: string } | undefined;
    if (last?.at && now.getTime() - Date.parse(last.at) < DAY_MS) {
      logger.debug(`workstate: ${key} was nudged for ${cause.kind} ${cause.ref} within a day`);
      return;
    }

    const event: WorkflowEvent = {
      type: "ticket.block_maybe_resolved",
      subject: { ticket: key },
      actor: { ...WORKSTATE_ACTOR },
      data: { cause: cause.kind, ref: cause.ref, why: cause.why, at: now.toISOString() },
    };

    await recordSynthetic(
      store,
      ctx,
      event,
      `ticket.block_maybe_resolved:${id}:${now.toISOString()}`,
    );

    await store.upsertSubject(NUDGES, id, { at: now.toISOString() });
    logger.info(`workstate: ticket.block_maybe_resolved on ${key}: ${cause.why}`);
  };

  /** A trusted human's comment on one ticket that names a blocked ticket assigned to them. */
  const onComment = async (ctx: RefreshCtx, event: WorkflowEvent) => {
    const body = event.data["body"];
    const on = event.subject.ticket!;
    if (
      event.actor.kind !== "human" ||
      event.data["untrusted"] === true ||
      typeof body !== "string"
    ) {
      return;
    }

    const named = new Set([...body.matchAll(ANY_KEY)].map((m) => m[1]!.toUpperCase()));
    for (const key of named) {
      const rec = tickets.get(key);
      if (key !== on && rec && assignedTo(rec, event.actor.id)) {
        await nudge(ctx, key, {
          kind: "comment",
          ref: on,
          why: `${event.actor.id}, who holds it, wrote about it on ${on}`,
        });
      }
    }
  };

  return { nudge, onComment };
}
