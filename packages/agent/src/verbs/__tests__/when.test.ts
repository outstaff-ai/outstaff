import { describe, expect, it } from "vitest";
import { ago, when } from "#/verbs/when.js";

const NOW = new Date("2026-01-31T12:00:00Z");

describe("when", () => {
  it("says how long ago a time was", () => {
    expect(ago("2026-01-31T11:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-01-31T11:55:00Z", NOW)).toBe("5 min ago");
    expect(ago("2026-01-31T09:00:00Z", NOW)).toBe("3 h ago");
    expect(ago("2026-01-28T12:00:00Z", NOW)).toBe("3 days ago");
    expect(ago("not a time", NOW)).toBe("at an unknown time");
  });

  it("gives the time to the minute in UTC with its age", () => {
    expect(when("2026-01-31T10:00:00+01:00", NOW)).toBe("2026-01-31 09:00 UTC, 3 h ago");
    expect(when("yesterday", NOW)).toBe("yesterday");
  });
});
