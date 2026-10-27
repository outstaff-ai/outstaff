import { parseTeamConfig, type Logger, type TeamConfig } from "@outstaff/core";
import { beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import type { ManualClock } from "#/types.js";
import { createScheduler } from "#/scheduler/index.js";
import { openStore, type Store } from "#/store/index.js";
import { createUsageTracker, usageGroupOf } from "#/usage/usage.js";
import type { UsageTracker } from "#/usage/types.js";

function team(shared?: string[][]): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      { handle: "sam", name: "Sam", role: "developer" },
      { handle: "kim", name: "Kim", role: "developer" },
      { handle: "mira", name: "Mira", role: "architect" },
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
    },
    ...(shared ? { policies: { usage: { shared } } } : {}),
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

describe("usage tracker", () => {
  let clock: ManualClock;
  let store: Store;
  let warnings: string[];
  const log: Logger = {
    debug() {},
    info() {},
    warn: (m) => void warnings.push(m),
    error() {},
  };

  const make = (shared?: string[][]): UsageTracker =>
    createUsageTracker({ store, team: team(shared), clock, logger: log });

  beforeEach(async () => {
    clock = manualClock();
    warnings = [];
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
  });

  it("returns the latest windows of a person", async () => {
    const usage = make();
    await usage.report("sam", [{ name: "five_hour", utilization: 0.4 }]);
    await usage.report("sam", [
      { name: "five_hour", utilization: 0.5 },
      { name: "seven_day", utilization: 0.7, resetsAt: "2030-01-05T00:00:00Z" },
    ]);

    expect(await usage.windows("sam")).toHaveLength(2);
    expect(await usage.summary("sam")).toEqual({
      window: "seven_day",
      utilization: 0.7,
      resetsAt: "2030-01-05T00:00:00Z",
    });

    expect(await usage.windows("kim")).toEqual([]);
  });

  it("treats a report older than 30 minutes as unknown and warns once", async () => {
    const usage = make();
    await usage.report("sam", [{ name: "five_hour", utilization: 0.99 }]);
    clock.advance(29 * 60_000);
    expect(await usage.windows("sam")).toHaveLength(1);
    expect(warnings).toEqual([]);

    clock.advance(2 * 60_000);
    expect(await usage.windows("sam")).toEqual([]);
    expect(await usage.windows("sam")).toEqual([]);
    expect(await usage.summary("sam")).toBeUndefined();
    expect(warnings).toHaveLength(1);

    await usage.report("sam", [{ name: "five_hour", utilization: 0.1 }]);
    expect(await usage.windows("sam")).toHaveLength(1);
  });

  it("ignores a window whose reset time has passed", async () => {
    const usage = make();
    await usage.report("sam", [
      { name: "five_hour", utilization: 0.99, resetsAt: "2030-01-01T00:10:00Z" },
      { name: "seven_day", utilization: 0.3 },
    ]);

    clock.advance(11 * 60_000);
    expect(await usage.windows("sam")).toEqual([{ name: "seven_day", utilization: 0.3 }]);
  });

  it("applies a report to everyone in a shared group, and to no one else", async () => {
    const usage = make([["sam", "kim"]]);
    await usage.report("kim", [{ name: "five_hour", utilization: 0.96 }]);

    expect(await usage.windows("sam")).toHaveLength(1);
    expect(await usage.windows("kim")).toHaveLength(1);
    expect(await usage.windows("mira")).toEqual([]);
    expect(usageGroupOf(team([["sam", "kim"]]), "mira")).toEqual(["mira"]);
  });

  it("keeps a shared group to the members on the reporter's runtime: a credential belongs to one", async () => {
    // Validation rejects such a group; a report still never crosses runtimes when one slips through.
    const mixed = team([["sam", "kim", "mira"]]);
    mixed.people[2]!.runtime = { adapter: "acme-alt" };
    expect(usageGroupOf(mixed, "sam")).toEqual(["sam", "kim"]);
    expect(usageGroupOf(mixed, "mira")).toEqual(["mira"]);

    const usage = createUsageTracker({ store, team: mixed, clock, logger: log });
    await usage.report("kim", [{ name: "five_hour", utilization: 0.96 }]);
    expect(await usage.windows("sam")).toHaveLength(1);
    expect(await usage.windows("mira")).toEqual([]);
  });

  it("feeds the scheduler: automatic work is held above the threshold, humans are not", async () => {
    const usage = make([["sam", "kim"]]);
    const scheduler = createScheduler({ store, team: team(), clock, usage });
    await usage.report("kim", [{ name: "five_hour", utilization: 0.96 }]);

    expect(await scheduler.isPausedFor("sam", { trigger: "agent" })).toMatchObject({
      code: "usage_pause",
    });

    expect(await scheduler.isPausedFor("sam", { trigger: "human" })).toBeNull();
    expect(await scheduler.isPausedFor("mira", { trigger: "agent" })).toBeNull();
  });
});
