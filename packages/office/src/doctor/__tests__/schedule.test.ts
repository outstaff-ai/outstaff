import { describe, expect, it } from "vitest";
import { presentHealth, uniqueNames } from "#/doctor/present.js";
import { nextDailyRun } from "#/doctor/schedule.js";

describe("nextDailyRun", () => {
  it("is today when the time is still ahead, else tomorrow, in local time", () => {
    const at = (h: number, m = 0, d = 1) => new Date(2030, 0, d, h, m);
    expect(nextDailyRun(at(5), "06:00")).toEqual(at(6));
    expect(nextDailyRun(at(6), "06:00")).toEqual(at(6, 0, 2));
    expect(nextDailyRun(at(23, 59), "00:30")).toEqual(at(0, 30, 2));
  });
});

describe("presentHealth", () => {
  it("puts failures first, then warnings, by scope and name, and counts them", () => {
    const seen = { firstSeen: "2030-01-01T00:00:00.000Z", lastSeen: "2030-01-01T00:00:00.000Z" };
    const health = presentHealth(
      [
        { scope: "sam", name: "b", status: "ok", detail: "", ...seen },
        { scope: "sam", name: "a", status: "warn", detail: "", ...seen },
        { scope: "office", name: "z", status: "fail", detail: "", ...seen },
        { scope: "office", name: "a", status: "ok", detail: "", ...seen },
        { scope: "mira", name: "y", status: "fail", detail: "", ...seen },
      ],
      undefined,
      new Date("2030-01-02T00:00:00.000Z"),
    );

    expect(health.checks.map((c) => `${c.scope}/${c.name}`)).toEqual([
      "mira/y",
      "office/z",
      "sam/a",
      "office/a",
      "sam/b",
    ]);

    expect(health).toMatchObject({
      at: "2030-01-02T00:00:00.000Z",
      lastRun: null,
      summary: { ok: 2, warn: 1, fail: 2 },
    });
  });

  it("numbers a name repeated within one run", () => {
    expect(uniqueNames([{ name: "a" }, { name: "b" }, { name: "a" }, { name: "a" }])).toEqual([
      { name: "a" },
      { name: "b" },
      { name: "a (2)" },
      { name: "a (3)" },
    ]);
  });
});
