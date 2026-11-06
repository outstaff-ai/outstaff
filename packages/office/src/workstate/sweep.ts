import type { WorkflowEvent } from "@outstaff/core";
import type { RefreshCtx, WorkstateCore } from "./core.types.js";
import { findStale } from "./stale.js";
import type { StaleTicket } from "./stale.types.js";
import { recordSynthetic, WORKSTATE_ACTOR } from "./synthetic.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SWEEP = "reconcile";
const SEEN = "reconcile_seen";

/** `2h`, `30m` or `0.5m` in milliseconds; undefined for `off`. */
export function everyMs(every: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([mh])$/.exec(every);
  return m ? Number(m[1]) * (m[2] === "h" ? HOUR : MINUTE) : undefined;
}

/**
 * The periodic board sweep, run with the merge follow-up on the office's poll: every `policies.reconcile.every` (the
 * first one that long after the office first ran it), it lists the open tickets out of step with the facts and raises
 * `board.stale` with them when there are any. A ticket is listed again for the same reason only after a day.
 */
export function createSweep(core: WorkstateCore) {
  const { store, clock, logger, team } = core;
  const settings = team.policies?.reconcile;
  const every = everyMs(settings?.every ?? "2h");
  const staleMs = (settings?.stale_hours ?? 48) * HOUR;

  /** Not listed for the same reason in the last day; remembered in the store, so across restarts. */
  const fresh = async (found: StaleTicket[], now: Date) => {
    const out: StaleTicket[] = [];
    for (const f of found) {
      const id = `${f.ticket}|${f.reason}`;
      const at = ((await store.getSubject(SEEN, id))?.data as { at?: string } | undefined)?.at;
      if (!at || now.getTime() - Date.parse(at) >= DAY) {
        out.push(f);
        await store.upsertSubject(SEEN, id, { at: now.toISOString() });
      }
    }

    return out;
  };

  /** Whether a sweep is due now; the first call only starts the clock. */
  const due = async (now: Date) => {
    const last = ((await store.getSubject(SWEEP, "last"))?.data as { at?: string } | undefined)?.at;
    if (last && now.getTime() - Date.parse(last) < every!) {
      return false;
    }

    await store.upsertSubject(SWEEP, "last", { at: now.toISOString() });
    return last !== undefined;
  };

  return {
    async sweepIfDue(ctx: RefreshCtx) {
      const now = clock.now();
      if (every === undefined || !(await due(now))) {
        return;
      }

      const found = await fresh(findStale(core, now, staleMs), now);
      logger.info(`workstate: the board sweep found ${found.length} ticket(s) out of step`);
      if (found.length === 0) {
        return;
      }

      const event: WorkflowEvent = {
        type: "board.stale",
        subject: { ticket: found[0]!.ticket },
        actor: { ...WORKSTATE_ACTOR },
        data: { tickets: found, at: now.toISOString() },
      };

      await recordSynthetic(store, ctx, event, `board.stale:${now.toISOString()}`);
    },
  };
}
