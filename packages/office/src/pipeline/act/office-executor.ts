import { applyActOps, trackerMemberOf, type ActOp } from "@outstaff/core";
import type { Act } from "../decisions.types.js";
import type { ActExecutor, OfficeActExecutorOptions } from "./act.types.js";
import { actId, recordActResult } from "./results.js";

/** The act's changes, then its note as a comment on their ticket, so the ticket's history says whom they were for. */
function withNote(act: Act): ActOp[] {
  const ticket = act.ops.flatMap((o) => ("ticket" in o ? [o.ticket] : []))[0];
  return act.note && ticket
    ? [...act.ops, { op: "comment", on: { ticket }, body: act.note }]
    : act.ops;
}

/**
 * Acts made by the office itself, through its own tracker and knowledge ports, on behalf of the agent the act names
 * (decision 0016). Each act is made once per event; its result goes on the event's trace.
 */
export function createOfficeActExecutor(opts: OfficeActExecutorOptions): ActExecutor {
  const { tracker, knowledge, traces } = opts;
  return {
    async execute(act, eventId) {
      const id = actId(eventId, act.policy);
      if ((await traces.get(eventId))?.results?.[id]) {
        return;
      }

      const outcome = await applyActOps(withNote(act), { tracker, knowledge }, async (target) =>
        trackerMemberOf(target, opts.team, tracker!),
      );

      await recordActResult(traces, eventId, id, outcome);
    },
  };
}
