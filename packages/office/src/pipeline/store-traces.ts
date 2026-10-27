import type { Store, StoredTrace } from "../store/index.js";
import type { Trace, TraceStore } from "./trace.types.js";

const toTrace = (s: StoredTrace) => s.data as Trace;

/** Traces kept in the office store, where `ost explain` reads them. */
export function createStoreTraceStore(
  store: Pick<Store, "recordTrace" | "getTrace" | "listTraces">,
): TraceStore {
  return {
    record: (trace) =>
      store.recordTrace({
        ref: trace.event.id,
        type: trace.event.type,
        at: trace.event.at,
        data: trace,
      }),
    get: async (id) => {
      const found = await store.getTrace(id);
      return found && toTrace(found);
    },
    list: async (query) => (await store.listTraces(query)).map(toTrace),
  };
}
