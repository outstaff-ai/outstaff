import { PortError } from "@outstaff/core";

// Re-read this much before the newest time seen; intake de-duplicates by external id.
export const OVERLAP_MS = 5 * 60_000;

export interface EventCursor {
  since: number;
  seen: Set<string>;
}

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
