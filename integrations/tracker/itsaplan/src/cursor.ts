import { PortError } from "@outstaff/core";
import type { EventCursor } from "./types.js";

// Re-read this much before the newest time seen; intake de-duplicates by external id.
export const OVERLAP_MS = 5 * 60_000;

/** Undefined means "no usable position": an old cursor shape counts as no entry and is baselined. */
export function parseCursor(cursor: string | undefined): EventCursor | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(cursor) as { since?: unknown; seen?: unknown };
    if (parsed && typeof parsed === "object") {
      const since = typeof parsed.since === "string" ? Date.parse(parsed.since) : Number.NaN;
      const seen = Array.isArray(parsed.seen) ? parsed.seen.map(String) : [];
      return Number.isNaN(since) ? undefined : { since, seen: new Set(seen) };
    }
  } catch {
    // fall through
  }

  throw new PortError("invalid", "Unrecognised event cursor.");
}

/**
 * The cursor after a read: the newest time seen (`now` when nothing has a time), and the ids read inside the overlap
 * of it. At baseline time every such id is kept, later only the ones the previous cursor had already seen, so that
 * history is not handed back as news.
 */
export function nextCursor(
  after: EventCursor | undefined,
  read: { id: string; at: number }[],
  now: () => number,
): string {
  const times = read.map((r) => r.at).filter((t) => !Number.isNaN(t));
  const newest = Math.max(after?.since ?? Number.NEGATIVE_INFINITY, ...times);
  const since = new Date(Number.isFinite(newest) ? newest : now()).toISOString();
  const keep = after?.seen;
  const seen = read
    .filter((r) => (keep ? keep.has(r.id) : true) && r.at >= Date.parse(since) - OVERLAP_MS)
    .map((r) => r.id);

  return JSON.stringify({ since, ...(seen.length > 0 ? { seen } : {}) });
}
