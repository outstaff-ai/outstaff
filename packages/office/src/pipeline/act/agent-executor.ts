import type { ActOp } from "@outstaff/core";
import type { Act } from "#/pipeline/decisions.types.js";
import type { TraceStore } from "#/pipeline/trace.types.js";
import type { ActDesk, ActExecutor } from "./act.types.js";
import { actId } from "./results.js";

/** The act's changes, then its note as a comment on their ticket. */
function withNote(act: Act): ActOp[] {
  const ticket = act.ops.flatMap((o) => ("ticket" in o ? [o.ticket] : []))[0];
  return act.note && ticket
    ? [...act.ops, { op: "comment", on: { ticket }, body: act.note }]
    : act.ops;
}

/**
 * Acts made by the agent each is for, through its own process and with its own tracker and knowledge credentials
 * (decision 0019). Each act is handed over once per event; its progress goes on the event's trace.
 */
export function createAgentActExecutor(opts: { traces: TraceStore; acts: ActDesk }): ActExecutor {
  const { traces, acts } = opts;
  return {
    async execute(act, eventId) {
      const id = actId(eventId, act.policy);
      if ((await traces.get(eventId))?.results?.[id]) {
        return;
      }

      await acts.send(act.as, { id, ops: withNote(act), event: eventId });
    },
  };
}
