import type { Trace } from "#/pipeline/trace.types.js";
import type { Store } from "#/store/index.js";

const REPO = { host: "github.com", owner: "acme-example", name: "shop" };

/** A trace of an event at `at`; `pr` makes it about that pull request of acme-example/shop. */
export function trace(
  id: string,
  at: string,
  o: { ticket?: string; pr?: number; actor?: string; wake?: string; act?: string } = {},
): Trace {
  return {
    event: {
      id,
      type: "ticket.assigned",
      at,
      subject: {
        ...(o.ticket ? { ticket: o.ticket } : {}),
        ...(o.pr ? { pr: { repo: REPO, number: o.pr } } : {}),
      },
      actor: { kind: "human", id: o.actor ?? "ada.admin" },
      data: {},
    },
    policies: [],
    aggregation: [],
    decisions: [
      ...(o.wake
        ? [
            {
              type: "wake" as const,
              policy: "p",
              person: o.wake,
              kind: "assigned",
              instruction: "Do it.",
              feedback: [],
              subject: { type: "ticket" as const, ref: "ACME-1" },
              coalesceMs: 60_000,
            },
          ]
        : []),
      ...(o.act ? [{ type: "act" as const, policy: "q", as: o.act, ops: [] }] : []),
      { type: "drop" as const, reason: "no policy matched" },
    ],
  };
}

export const record = (store: Store, t: Trace) =>
  store.recordTrace({ ref: t.event.id, type: t.event.type, at: t.event.at, data: t });
