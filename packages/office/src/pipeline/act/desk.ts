import type { ActOp } from "@outstaff/core";
import type { QueuedAct } from "@outstaff/protocol";
import type { ActDesk, ActDeskOptions, PendingAct } from "./act.types.js";
import { createActQueue } from "./pending.js";
import { actRecords } from "./results.js";

/** The tickets whose state the ops change; a comment changes none. */
const changedTickets = (ops: ActOp[]): string[] => [
  ...new Set(ops.flatMap((o) => (o.op === "comment" ? [] : [o.ticket]))),
];

const wire = (act: PendingAct): QueuedAct => ({ id: act.id, ops: act.ops });

/**
 * Acts go to the agent they are for, which makes the changes as itself (decision 0019): sent at once when the agent
 * is connected, else queued for its next `welcome`, and sent again until it answers. The office's own tracker account
 * only reads.
 */
export function createActDesk(opts: ActDeskOptions): ActDesk {
  const { clock, logger: log } = opts;
  const queue = createActQueue(opts.store);
  const update = actRecords(opts.traces);
  const now = () => clock.now().toISOString();

  const delivered = async (act: PendingAct) => {
    if (act.event) {
      await update(act.event, act.id, (was) =>
        was ? { ...was, status: "delivered", deliveredAt: now() } : undefined,
      );
    }
  };

  return {
    async send(person, act) {
      await queue.add(person, act);
      if (act.event) {
        await update(
          act.event,
          act.id,
          (was) => was ?? { status: "queued", queuedAt: now(), results: [] },
        );
      }

      if (opts.push(person, wire(act))) {
        await delivered(act);
      }
    },

    async deliver(person) {
      const acts = await queue.list(person);
      for (const act of acts) {
        await delivered(act);
      }

      return acts.map(wire);
    },

    async result(person, r) {
      const act = await queue.take(person, r.id);
      if (!act) {
        return;
      }

      // The office's state follows the change at once, so the next decisions see it.
      for (const key of changedTickets(act.ops)) {
        await opts.workState.refreshTicket(key).catch((err: unknown) => {
          log.warn("could not read a ticket an act changed", { ticket: key, error: String(err) });
        });
      }

      if (act.event) {
        await update(act.event, act.id, (was) => ({
          queuedAt: now(),
          ...was,
          status: r.ok ? "done" : "failed",
          finishedAt: now(),
          results: r.results,
          ...(r.error ? { error: r.error } : {}),
        }));
      }

      if (!r.ok) {
        log.warn(`act ${act.id} of ${person} failed`, { error: r.error });
      }
    },
  };
}
