import type { Trace, TraceStore } from "./trace.types.js";

/** Traces kept in memory, for tests and the replay harness. */
export function createMemoryTraceStore(): TraceStore {
  const traces = new Map<string, Trace>();
  return {
    async record(trace) {
      const results = trace.results ?? traces.get(trace.event.id)?.results;
      traces.set(trace.event.id, structuredClone({ ...trace, ...(results ? { results } : {}) }));
    },
    async get(id) {
      const t = traces.get(id);
      return t && structuredClone(t);
    },
    async list(query = {}) {
      return [...traces.values()]
        .filter((t) => query.before === undefined || t.event.at < query.before)
        .toSorted((a, b) => b.event.at.localeCompare(a.event.at))
        .slice(0, query.limit ?? 50)
        .map((t) => structuredClone(t));
    },
  };
}
