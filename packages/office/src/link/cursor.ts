import type { Trace } from "#/pipeline/trace.types.js";
import type { OfficeLinkOptions, TraceCursor } from "./link.types.js";

type Item = { recordedAt: string; trace: Trace };

/**
 * The next traces to send, in recording order, and the cursor after them. Recording times can repeat, so the cursor
 * keeps which traces of its last time were sent, and skips only those.
 */
export async function nextTraces(
  store: Pick<OfficeLinkOptions["store"], "listTracesRecorded">,
  cursor: TraceCursor,
  limit: number,
): Promise<{ items: Item[]; cursor: TraceCursor }> {
  const rows = await store.listTracesRecorded({
    from: cursor.from,
    limit: limit + cursor.sent.size,
  });

  const fresh = rows
    .filter((r) => !(r.recordedAt === cursor.from && cursor.sent.has(r.ref)))
    .slice(0, limit);

  const last = fresh.at(-1)?.recordedAt;
  if (last === undefined) {
    return { items: [], cursor };
  }

  const atLast = fresh.filter((r) => r.recordedAt === last).map((r) => r.ref);
  return {
    items: fresh.map((r) => ({ recordedAt: r.recordedAt, trace: r.data as Trace })),
    cursor: {
      from: last,
      sent: new Set([...(last === cursor.from ? cursor.sent : []), ...atLast]),
    },
  };
}
