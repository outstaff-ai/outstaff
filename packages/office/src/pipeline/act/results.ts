import type { ActRecord, TraceStore } from "#/pipeline/trace.types.js";

/** The id of the act a policy decided for an event. */
export const actId = (eventId: string, policy: string): string => `${eventId}:${policy}`;

/** Changes the record of an act on its event's trace; one change at a time, so none is lost. */
export function actRecords(traces: TraceStore) {
  let chain: Promise<unknown> = Promise.resolve();

  return (
    eventId: string,
    id: string,
    change: (was: ActRecord | undefined) => ActRecord | undefined,
  ): Promise<void> => {
    const run = chain.then(async () => {
      const trace = await traces.get(eventId);
      const next = trace && change(trace.results?.[id]);
      if (trace && next) {
        await traces.record({ ...trace, results: { ...trace.results, [id]: next } });
      }
    });

    chain = run.catch(() => undefined);
    return run;
  };
}
