import { describe, expect, it } from "vitest";
import { localDateIn, splitByCalendar } from "#/usage/calendar.js";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const pieces = (tz: string, unit: "day" | "month" | undefined, from: string, to: string) =>
  splitByCalendar(localDateIn(tz), unit, at(from), at(to)).map((p) => [
    iso(p.from),
    iso(p.to),
    p.key,
  ]);

describe("calendar", () => {
  it("gives the local date of an instant", () => {
    expect(localDateIn("Asia/Tokyo")(at("2026-10-31T15:00:00Z"))).toBe("2026-11-01");
    expect(localDateIn("UTC")(at("2026-10-31T15:00:00Z"))).toBe("2026-10-31");
    expect(() => localDateIn("Acme/Nowhere")).toThrow(RangeError);
  });

  it("cuts an interval at local midnights, through a daylight saving change", () => {
    // Lisbon moves to summer time on 2026-03-29, so that day has 23 hours.
    expect(pieces("Europe/Lisbon", "day", "2026-03-28T22:00:00Z", "2026-03-30T02:00:00Z")).toEqual([
      ["2026-03-28T22:00:00.000Z", "2026-03-29T00:00:00.000Z", "2026-03-28"],
      ["2026-03-29T00:00:00.000Z", "2026-03-29T23:00:00.000Z", "2026-03-29"],
      ["2026-03-29T23:00:00.000Z", "2026-03-30T02:00:00.000Z", "2026-03-30"],
    ]);
  });

  it("cuts an interval where a local month starts", () => {
    expect(pieces("Asia/Tokyo", "month", "2026-10-31T14:00:00Z", "2026-10-31T16:30:00Z")).toEqual([
      ["2026-10-31T14:00:00.000Z", "2026-10-31T15:00:00.000Z", "2026-10"],
      ["2026-10-31T15:00:00.000Z", "2026-10-31T16:30:00.000Z", "2026-11"],
    ]);
  });

  it("keeps an interval whole within a day, up to its midnight, without a unit, and when empty", () => {
    expect(pieces("UTC", "day", "2026-10-05T08:00:00Z", "2026-10-06T00:00:00Z")).toEqual([
      ["2026-10-05T08:00:00.000Z", "2026-10-06T00:00:00.000Z", "2026-10-05"],
    ]);

    expect(pieces("UTC", undefined, "2026-10-05T08:00:00Z", "2026-11-06T00:00:00Z")).toEqual([
      ["2026-10-05T08:00:00.000Z", "2026-11-06T00:00:00.000Z", ""],
    ]);

    expect(pieces("UTC", "day", "2026-10-05T08:00:00Z", "2026-10-05T08:00:00Z")).toEqual([
      ["2026-10-05T08:00:00.000Z", "2026-10-05T08:00:00.000Z", "2026-10-05"],
    ]);
  });
});
