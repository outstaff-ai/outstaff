import type { TraceStore } from "#/pipeline/trace.types.js";
import type { ContextManifest } from "./context.types.js";

/** Puts what a wake's bundle carried on the trace of the event that woke the item, when the event was traced. */
export async function recordContext(
  traces: Pick<TraceStore, "get" | "record">,
  eventIds: string[],
  manifest: ContextManifest,
): Promise<string | undefined> {
  for (const id of eventIds) {
    const trace = await traces.get(id);
    if (trace) {
      await traces.record({ ...trace, context: { ...trace.context, [manifest.itemId]: manifest } });
      return id;
    }
  }

  return undefined;
}
