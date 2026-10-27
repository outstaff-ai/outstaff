import type { Store, StoredTrace } from "#/store/index.js";
import type { Trace, TraceStore } from "./trace.types.js";

const toTrace = (s: StoredTrace) => s.data as Trace;

/** Traces kept in the office store, where `ost explain` reads them. */
export function createStoreTraceStore(
  store: Pick<Store, "recordTrace" | "getTrace" | "listTraces">,
): TraceStore {
  /** The trace as recorded before, when this one lacks what a record keeps: act results and wake contexts. */
  const before = async (trace: Trace) =>
    trace.results && trace.context
      ? undefined
      : await store.getTrace(trace.event.id).then((t) => t && toTrace(t));

  /** What an earlier record of the trace had that this one does not. */
  const keptOf = async (trace: Trace) => {
    const was = await before(trace);
    const results = trace.results ?? was?.results;
    const context = trace.context ?? was?.context;
    return { ...(results ? { results } : {}), ...(context ? { context } : {}) };
  };

  return {
    record: async (trace) => {
      const kept = await keptOf(trace);
      await store.recordTrace({
        ref: trace.event.id,
        type: trace.event.type,
        at: trace.event.at,
        data: { ...trace, ...kept },
      });
    },
    get: async (id) => {
      const found = await store.getTrace(id);
      return found && toTrace(found);
    },
    list: async (query) => (await store.listTraces(query)).map(toTrace),
  };
}
