import type { CalendarPiece, CalendarUnit } from "./period.types.js";

const DAY_SECONDS = 24 * 3600;

/** How far past an instant its next day or month surely starts, in seconds. */
const SPAN: Record<CalendarUnit, number> = { day: 2 * DAY_SECONDS, month: 33 * DAY_SECONDS };

/** The local date of an instant in the time zone, `YYYY-MM-DD`. Throws a RangeError for a zone Intl doesn't know. */
export function localDateIn(tz: string): (ms: number) => string {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return (ms) => {
    const parts = new Map(format.formatToParts(ms).map((p) => [p.type, p.value]));
    return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
  };
}

/**
 * The first instant after `ms` whose key is another: where the next local day or month starts. Offsets and midnights
 * fall on whole seconds, so a search by second finds it exactly, through daylight saving changes too.
 */
function nextBoundary(keyOf: (ms: number) => string, ms: number, unit: CalendarUnit): number {
  const key = keyOf(ms);
  let lo = Math.floor(ms / 1000);
  let hi = lo + SPAN[unit];
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (keyOf(mid * 1000) === key) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return hi * 1000;
}

/**
 * The interval `[from, to)` cut where a local day or month starts; an empty interval is one piece. Without a unit it
 * stays whole, with an empty key.
 */
export function splitByCalendar(
  date: (ms: number) => string,
  unit: CalendarUnit | undefined,
  from: number,
  to: number,
): CalendarPiece[] {
  if (!unit) {
    return [{ from, to, key: "" }];
  }

  const keyOf = unit === "day" ? date : (ms: number) => date(ms).slice(0, 7);
  const pieces: CalendarPiece[] = [];
  let at = from;
  while (keyOf(at) !== keyOf(Math.max(at, to - 1))) {
    const next = nextBoundary(keyOf, at, unit);
    pieces.push({ from: at, to: next, key: keyOf(at) });
    at = next;
  }

  pieces.push({ from: at, to, key: keyOf(at) });
  return pieces;
}
