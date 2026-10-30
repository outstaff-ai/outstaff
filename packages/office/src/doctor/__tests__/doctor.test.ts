import { AdapterRegistry, defineAdapter, type Logger, type TeamConfig } from "@outstaff/core";
import { createFakeAdapterRegistry } from "@outstaff/core/fakes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { openStore, type Store } from "#/store/index.js";
import type { ManualClock } from "#/types.js";
import { createOfficeDoctor } from "#/doctor/doctor.js";
import type { OfficeDoctor } from "#/doctor/types.js";

const team = (dailyAt?: string, skip?: string[]) =>
  ({
    team: { name: "acme" },
    people: [{ handle: "sam", name: "Sam", role: "developer", model: "sonnet" }],
    integrations: { chat: { adapter: "fake", workspace: "acme" } },
    ...(dailyAt || skip
      ? { office: { doctor: { daily_at: dailyAt ?? "06:00", ...(skip ? { skip } : {}) } } }
      : {}),
  }) as unknown as TeamConfig;

describe("the office's doctor", () => {
  let clock: ManualClock;
  let store: Store;
  let secrets: Record<string, string>;
  let answer: () => Promise<{ name: string; status: "ok" | "fail"; detail: string }[]>;
  let calls: number;
  let lines: [string, string, unknown][];
  let doctor: OfficeDoctor;

  const registry = () =>
    new AdapterRegistry().register(
      defineAdapter({
        port: "chat",
        name: "fake",
        capabilities: [],
        options: createFakeAdapterRegistry().get("chat", "fake")!.options,
        secrets: () => [],
        create: () => ({}) as never,
        doctor: async (_s, ctx) => {
          calls += 1;
          expect(ctx).toMatchObject({ scope: "office", options: { workspace: "acme" } });
          return answer();
        },
      }),
    );

  const log = (level: string) => (m: string, f?: unknown) => void lines.push([level, m, f]);
  const make = (t = team(), extra: Partial<Parameters<typeof createOfficeDoctor>[0]> = {}) =>
    (doctor = createOfficeDoctor({
      team: t,
      registry: registry(),
      secrets: { get: (k) => secrets[k], require: (k) => secrets[k]! },
      secretsDir: "/run/secrets/outstaff",
      store,
      clock,
      logger: {
        debug: log("debug"),
        info: log("info"),
        warn: log("warn"),
        error: log("error"),
      } as Logger,
      ...extra,
    }));

  const settle = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(async () => {
    // 05:00 local time, so the default daily run is an hour away.
    clock = manualClock(new Date(2030, 0, 1, 5, 0).toISOString());
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    secrets = { OUTSTAFF_AGENT_TOKEN_SAM: "a-long-token" };
    answer = async () => [{ name: "Slack token", status: "ok", detail: "Valid." }];
    calls = 0;
    lines = [];
  });

  afterEach(async () => {
    await doctor.stop();
    await store.close();
  });

  it("runs at start and daily at 06:00, flags a removed secret and clears it once it is back", async () => {
    make();
    expect(doctor.lastRun()).toBeUndefined();
    doctor.start();
    await settle();
    expect(calls).toBe(1);
    expect(doctor.lastRun()).toBe(clock.now().toISOString());
    expect((await doctor.health()).summary).toEqual({ ok: 2, warn: 0, fail: 0 });

    delete secrets["OUTSTAFF_AGENT_TOKEN_SAM"];
    clock.advance(59 * 60_000);
    await settle();
    expect(calls).toBe(1);
    clock.advance(60_000);
    await settle();
    expect(calls).toBe(2);
    const failing = await doctor.health();
    expect(failing.checks[0]).toMatchObject({
      scope: "office",
      name: "OUTSTAFF_AGENT_TOKEN_SAM present",
      status: "fail",
      key: "OUTSTAFF_AGENT_TOKEN_SAM",
      firstSeen: new Date(2030, 0, 1, 6, 0).toISOString(),
    });

    expect(lines).toContainEqual([
      "warn",
      "doctor: OUTSTAFF_AGENT_TOKEN_SAM present",
      expect.objectContaining({ scope: "office", status: "fail" }),
    ]);

    expect(await doctor.component()).toEqual({ ok: true, detail: "1 ok, 0 warn, 1 fail" });

    // Still failing a day later; restored, the next run (on demand) passes.
    clock.advance(24 * 3600_000);
    await settle();
    expect(calls).toBe(3);
    expect((await doctor.health()).checks[0]!.firstSeen).toBe(
      new Date(2030, 0, 1, 6, 0).toISOString(),
    );

    secrets["OUTSTAFF_AGENT_TOKEN_SAM"] = "a-long-token";
    await doctor.run();
    expect((await doctor.health()).summary).toEqual({ ok: 2, warn: 0, fail: 0 });
  });

  it("adds the extra checks of the office's own ports to each run", async () => {
    let extraRuns = 0;
    make(team(), {
      extraChecks: async () => {
        extraRuns += 1;
        return [{ name: "Merge gate of app", status: "warn", detail: "main requires checks ci." }];
      },
    });

    await doctor.run();
    await doctor.run();
    expect(extraRuns).toBe(2);
    expect((await doctor.health()).checks).toContainEqual(
      expect.objectContaining({ scope: "office", name: "Merge gate of app", status: "warn" }),
    );
  });

  it("joins a run in progress, keeps agents' reports and numbers repeated names", async () => {
    make(team("05:30"));
    let release!: () => void;
    answer = () =>
      new Promise(
        (r) => (release = () => r([{ name: "Slack token", status: "ok", detail: "Valid." }])),
      );

    doctor.start();
    const joined = doctor.run();
    await settle();
    release();
    await joined;
    expect(calls).toBe(1);

    await doctor.report("sam", [
      { name: "Note", status: "warn", detail: "First." },
      { name: "Note", status: "warn", detail: "Second." },
    ]);

    expect((await doctor.health()).checks.slice(0, 2).map((c) => [c.scope, c.name])).toEqual([
      ["sam", "Note"],
      ["sam", "Note (2)"],
    ]);

    // 05:30 is half an hour away.
    answer = async () => [];
    clock.advance(30 * 60_000);
    await settle();
    expect(calls).toBe(2);
  });

  it("leaves out the live checks of a skipped port and still checks the secrets", async () => {
    make(team(undefined, ["chat"]));
    await doctor.run();
    expect(calls).toBe(0);
    expect((await doctor.health()).checks.map((c) => c.name)).toEqual([
      "OUTSTAFF_AGENT_TOKEN_SAM present",
    ]);
  });

  it("logs a run that fails and an unreadable store, and never throws", async () => {
    make(team(), {
      store: {
        recordDoctorRun: () => Promise.reject(new Error("disk full")),
        listDoctorChecks: () => Promise.reject(new Error("disk gone")),
      },
    });

    await doctor.run();
    expect(lines).toContainEqual([
      "warn",
      "doctor: the office's checks could not run",
      { error: "Error: disk full" },
    ]);

    expect(doctor.lastRun()).toBeUndefined();
    expect(await doctor.component()).toEqual({ ok: true, detail: "unknown: Error: disk gone" });
  });

  it("gives up a run that takes too long and keeps the stored checks", async () => {
    make(team(), { runTimeoutMs: 1000 });
    await doctor.run();
    answer = () => new Promise(() => {});
    const stuck = doctor.run();
    await settle();
    clock.advance(1000);
    await stuck;
    expect(lines).toContainEqual([
      "warn",
      "doctor: the office's checks could not run",
      { error: "Error: no result within 1000 ms" },
    ]);

    expect((await doctor.health()).summary).toEqual({ ok: 2, warn: 0, fail: 0 });
  });

  it("stops its daily runs and waits for the one in progress", async () => {
    make();
    let release!: () => void;
    answer = () => new Promise((r) => (release = () => r([])));
    doctor.start();
    await settle();
    const stopped = doctor.stop();
    release();
    await stopped;
    clock.advance(48 * 3600_000);
    await settle();
    expect(calls).toBe(1);
  });
});
