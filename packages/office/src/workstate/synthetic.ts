import type { WorkflowEvent } from "@outstaff/core";
import type { Store } from "#/store/index.js";
import type { RefreshCtx } from "./core.types.js";

/** The actor of the events the work state derives. */
export const WORKSTATE_ACTOR = { kind: "automation", id: "workstate" } as const;

/**
 * Records an event the work state derived, once per `externalId`, and queues it for delivery when it is new. The stored
 * shape is the one intake delivers, so a crash before delivery is repaired by intake.
 */
export async function recordSynthetic(
  store: Store,
  ctx: RefreshCtx,
  event: WorkflowEvent,
  externalId: string,
): Promise<void> {
  const fresh = await store.recordEvent({
    source: "workstate",
    externalId,
    type: event.type,
    payload: { raw: { externalId, type: event.type }, event, trusted: true },
  });

  if (fresh) {
    ctx.fresh.push({ event, externalId });
  }
}
