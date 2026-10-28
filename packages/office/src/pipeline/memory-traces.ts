import type { Trace, TraceStore } from "./trace.types.js";

/** Traces kept in memory, for tests and the replay harness. */
export function createMemoryTraceStore(): TraceStore {
  const traces = new Map<string, Trace>();
  return {
    async record(trace) {
      const kept = traces.get(trace.event.id);
      const results = trace.results ?? kept?.results;
      const context = trace.context ?? kept?.context;
      traces.set(
        trace.event.id,
        structuredClone({
          ...trace,
          ...(results ? { results } : {}),
          ...(context ? { context } : {}),
        }),
      );
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
