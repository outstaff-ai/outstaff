import type { ActOutcome } from "@outstaff/core";
import type { TraceStore } from "#/pipeline/trace.types.js";

/** Puts an act's result on the trace of the event that decided it. */
export async function recordActResult(
  traces: TraceStore,
  eventId: string,
  actId: string,
  outcome: ActOutcome,
): Promise<void> {
  const trace = await traces.get(eventId);
  if (trace) {
    await traces.record({ ...trace, results: { ...trace.results, [actId]: outcome } });
  }
}

/** The id of the act a policy decided for an event. */
export const actId = (eventId: string, policy: string): string => `${eventId}:${policy}`;
