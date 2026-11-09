import { silentLogger } from "@outstaff/core";
import type { LinkRequest, LinkResultOf } from "@outstaff/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import type { OfficeLinkOptions } from "#/link/link.types.js";
import { answer } from "#/link/requests.js";
import { openStore, type Store } from "#/store/index.js";
import type { ManualClock } from "#/types.js";

const HOUR = 3600_000;

const counts = (model: string, n: number, costUsd: number | null) => ({
  model,
  inputTokens: n,
  outputTokens: n,
  cacheReadTokens: n,
  cacheCreationTokens: n,
  costUsd,
});

describe("period usage over the office link", () => {
  let store: Store;
  let clock: ManualClock;

  const ask = (params: Extract<LinkRequest, { method: "period_usage" }>["params"]) =>
    answer({ store, clock, logger: silentLogger } as unknown as OfficeLinkOptions, {
      id: "p",
      method: "period_usage",
      params,
    });

  const resultOf = async (params: Parameters<typeof ask>[0]) => {
    const res = await ask(params);
    if (!("result" in res)) {
      throw new Error(JSON.stringify(res));
    }

    return res.result as LinkResultOf<"period_usage">;
  };

  /** Starts a run of the person on a new item with the subject. */
  async function start(person: string, subject?: { type: string; ref: string }) {
    const item = await store.enqueue({
      person,
      kind: "assigned",
      title: "t",
      trigger: "human",
      ...(subject ? { subject } : {}),
    });

    return store.startRun(item.id);
  }

  beforeEach(async () => {
    clock = manualClock("2026-10-05T08:00:00.000Z");
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
  });

  afterEach(async () => {
    await store.close();
  });

  it("splits a run at local midnight, its time and its usage by duration", async () => {
    clock.advance(13 * HOUR);
    const run = await start("sam");
    await store.recordRunUsage(run.id, "s", [counts("claude-opus-5-5", 101, 1)]);
    clock.advance(4 * HOUR);
    await store.finishRun(run.id, { outcome: "done" });

    // 21:00 to 01:00 UTC is 22:00 to 02:00 in Lisbon, on summer time: two hours on each local day.
    const result = await resultOf({
      from: "2026-10-05T00:00:00.000Z",
      to: "2026-10-07T00:00:00.000Z",
      tz: "Europe/Lisbon",
      groupBy: ["day"],
    });

    expect(result).toMatchObject({
      tz: "Europe/Lisbon",
      groupBy: ["day"],
      totals: { inputTokens: 101, tokens: 404, costUsd: 1, runs: 1, runSeconds: 14400 },
      groups: [
        {
          day: "2026-10-05",
          totals: { inputTokens: 51, tokens: 204, runs: 1, runSeconds: 7200, busySeconds: 7200 },
        },
        {
          day: "2026-10-06",
          totals: { inputTokens: 50, tokens: 200, runs: 1, runSeconds: 7200, busySeconds: 7200 },
        },
      ],
    });

    expect(result.groups.map((g) => g.totals.costUsd)).toEqual([0.5, 0.5]);

    // In UTC the run crosses midnight an hour later, and a month needs no cut.
    const utc = await resultOf({
      from: "2026-10-05T00:00:00.000Z",
      to: "2026-10-07T00:00:00.000Z",
      groupBy: ["month", "day"],
    });

    expect(utc.groups).toMatchObject([
      { day: "2026-10-05", month: "2026-10", totals: { runSeconds: 10800, inputTokens: 76 } },
      { day: "2026-10-06", month: "2026-10", totals: { runSeconds: 3600, inputTokens: 25 } },
    ]);
  });

  it("counts a person's overlapping runs once in the busy time, and each run in the run time", async () => {
    const r1 = await start("sam", { type: "ticket", ref: "ACME-1" });
    await store.recordRunUsage(r1.id, "s1", [counts("claude-opus-5-5", 10, 0.3)]);
    clock.advance(HOUR);
    const r2 = await start("sam");
    await store.recordRunUsage(r2.id, "s2", [
      counts("claude-opus-5-5", 10, 0.2),
      counts("claude-haiku-5-5", 10, null),
    ]);

    const r3 = await start("kim", { type: "pr", ref: "github.com/acme/app#7" });
    clock.advance(HOUR / 2);
    await store.finishRun(r3.id, { outcome: "done" });
    clock.advance(HOUR / 2);
    await store.finishRun(r1.id, { outcome: "done" });
    clock.advance(HOUR);
    await store.finishRun(r2.id, { outcome: "done" });

    const from = "2026-10-05T00:00:00.000Z";
    const byPerson = await resultOf({ from, groupBy: ["person", "person"] });
    expect(byPerson).toMatchObject({
      to: "2026-10-05T11:00:00.000Z",
      groupBy: ["person"],
      totals: { runSeconds: 16200, busySeconds: 12600, runs: 2 },
      groups: [
        { person: "sam", totals: { runSeconds: 14400, busySeconds: 10800, runs: 2 } },
        { person: "kim", totals: { runSeconds: 1800, busySeconds: 1800, runs: 0, tokens: 0 } },
      ],
    });

    const byModel = await resultOf({ from, groupBy: ["model"] });
    expect(byModel.groups).toMatchObject([
      { model: "claude-opus-5-5", totals: { runSeconds: 14400, busySeconds: 10800, runs: 2 } },
      { model: "claude-haiku-5-5", totals: { runSeconds: 7200, tokens: 40, costUsd: 0 } },
      { model: null, totals: { runSeconds: 1800, runs: 0 } },
    ]);

    const bySubject = await resultOf({ from, groupBy: ["subject"] });
    expect(bySubject.groups.map((g) => g.subject)).toEqual([
      { type: "ticket", ref: "ACME-1" },
      null,
      { type: "pr", ref: "github.com/acme/app#7" },
    ]);
  });

  it("cuts a run at the period's edges, and counts a run that is still going up to now", async () => {
    const done = await start("sam");
    await store.recordRunUsage(done.id, "s1", [counts("claude-opus-5-5", 100, 4)]);
    clock.advance(4 * HOUR);
    await store.finishRun(done.id, { outcome: "done" });
    const going = await start("sam");
    await store.recordRunUsage(going.id, "s2", [counts("claude-opus-5-5", 10, 1)]);
    clock.advance(HOUR);

    const middle = await resultOf({ from: "2026-10-05T09:00:00Z", to: "2026-10-05T10:00:00Z" });
    expect(middle).toMatchObject({
      from: "2026-10-05T09:00:00.000Z",
      groupBy: [],
      totals: { inputTokens: 25, costUsd: 1, runSeconds: 3600, runs: 1 },
      groups: [],
    });

    // The finished run ends where the period starts, so only the one still going is in it.
    const now = await resultOf({ from: "2026-10-05T12:00:00Z" });
    expect(now.totals).toMatchObject({ inputTokens: 10, runSeconds: 3600, runs: 1 });
    expect(
      await resultOf({ from: "2026-10-06T00:00:00Z", to: "2026-10-07T00:00:00Z" }),
    ).toMatchObject({
      totals: { tokens: 0, runs: 0, runSeconds: 0, busySeconds: 0 },
      groups: [],
    });
  });

  it("counts a run that took no time where it happened", async () => {
    const run = await start("sam");
    await store.recordRunUsage(run.id, "s", [counts("claude-opus-5-5", 3, 0.1)]);
    await store.finishRun(run.id, { outcome: "done" });

    expect(
      await resultOf({
        from: "2026-10-05T08:00:00Z",
        to: "2026-10-05T09:00:00Z",
        groupBy: ["day"],
      }),
    ).toMatchObject({
      totals: { inputTokens: 3, runSeconds: 0, runs: 1 },
      groups: [{ day: "2026-10-05", totals: { inputTokens: 3 } }],
    });
  });

  it("refuses a period it can't count", async () => {
    const refused = async (params: Parameters<typeof ask>[0]) => {
      const res = await ask(params);
      return "error" in res ? res.error : res;
    };

    for (const params of [
      { from: "soon" },
      { from: "2026-10-05T09:00:00Z", to: "2026-10-05T09:00:00Z" },
      { from: "2026-10-06T00:00:00Z" },
    ]) {
      expect(await refused(params)).toEqual({
        code: "invalid",
        message: "`from` and `to` must be times, `from` before `to`.",
      });
    }

    expect(await refused({ from: "2025-01-01T00:00:00Z" })).toEqual({
      code: "invalid",
      message: "A period is at most 400 days.",
    });

    expect(await refused({ from: "2026-10-01T00:00:00Z", tz: "Acme/Nowhere" })).toEqual({
      code: "invalid",
      message: "Unknown time zone: Acme/Nowhere.",
    });
  });
});
