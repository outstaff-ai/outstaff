import { describe, expect, it } from "vitest";
import { nextTraces } from "../cursor.js";

const row = (ref: string, recordedAt: string) => ({
  ref,
  type: "ticket.assigned",
  at: recordedAt,
  recordedAt,
  data: { event: { id: ref } },
});

describe("nextTraces", () => {
  it("pages through traces that share a recording time without repeating or skipping one", async () => {
    const T = "2026-10-05T10:00:00.000Z";
    const rows = [row("a", T), row("b", T), row("c", T), row("d", "2026-10-05T10:00:00.001Z")];
    const store = {
      listTracesRecorded: async ({ from, limit }: { from?: string | undefined; limit: number }) =>
        rows.filter((r) => from === undefined || r.recordedAt >= from).slice(0, limit),
    };

    const seen: string[] = [];
    let cursor = { sent: new Set<string>() } as Parameters<typeof nextTraces>[1];
    for (let i = 0; i < 6; i++) {
      const next = await nextTraces(store, cursor, i < 2 ? 1 : 2);
      seen.push(...next.items.map((x) => (x.trace.event as { id: string }).id));
      cursor = next.cursor;
    }

    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(cursor).toEqual({ from: "2026-10-05T10:00:00.001Z", sent: new Set(["d"]) });
  });
});
