import { AdapterRegistry, silentLogger, type TeamConfig } from "@outstaff/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHealthServer,
  createOfficeDoctor,
  openStore,
  systemClock,
  type HealthServer,
  type Store,
} from "@outstaff/office";
import type { Context } from "#/types.js";
import { run } from "#/program.js";

const TEAM = {
  team: { name: "acme" },
  people: [{ handle: "sam", name: "Sam", role: "developer" }],
  integrations: {},
} as unknown as TeamConfig;

async function ost(args: string[], extra: Partial<Context> = {}) {
  let out = "";
  let err = "";
  const code = await run(args, {
    cwd: "/",
    env: {},
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    gitOrigin: () => undefined,
    ...extra,
  });

  return { code, out, err };
}

describe("ost doctor --via-office", () => {
  let store: Store;
  let server: HealthServer;
  let secrets: Record<string, string>;
  let base: string;

  beforeAll(async () => {
    store = await openStore("sqlite::memory:");
    secrets = { OUTSTAFF_AGENT_TOKEN_SAM: "a-long-token" };
    const doctor = createOfficeDoctor({
      team: TEAM,
      registry: new AdapterRegistry(),
      secrets: { get: (k) => secrets[k], require: (k) => secrets[k]! },
      secretsDir: "/nonexistent",
      store,
      clock: systemClock,
      logger: silentLogger,
    });

    await store.recordDoctorRun("sam", [
      {
        name: "Home volume space",
        status: "warn",
        detail: "82% used.",
        fix: "Free space or grow the volume.",
      },
    ]);

    server = createHealthServer(
      { health: async () => ({ ok: true, state: "running", components: {} }), parts: { doctor } },
      0,
      "127.0.0.1",
    );

    await server.start();
    base = `http://127.0.0.1:${server.port()}`;
  });

  afterAll(async () => {
    await server.stop();
    await store.close();
  });

  it("has the office run its checks now, so a removed secret fails and a restored one passes", async () => {
    delete secrets["OUTSTAFF_AGENT_TOKEN_SAM"];
    const failing = await ost(["doctor", "--via-office"], {
      env: { OUTSTAFF_OFFICE_HEALTH_URL: `${base}/` },
    });

    expect(failing.code).toBe(1);
    expect(failing.out).toContain("office\n  fail  OUTSTAFF_AGENT_TOKEN_SAM present");
    expect(failing.out).toMatch(/Fix: Create \/nonexistent\/OUTSTAFF_AGENT_TOKEN_SAM/);
    expect(failing.out).toContain("sam\n  warn  Home volume space: 82% used. (since ");
    expect(failing.out).toContain("0 ok, 1 warning, 1 failure");

    secrets["OUTSTAFF_AGENT_TOKEN_SAM"] = "a-long-token";
    const passing = await ost(["doctor", "office", "--via-office", "--json"], {
      env: { OUTSTAFF_OFFICE_URL: "ws://127.0.0.1:1/agent", OUTSTAFF_OFFICE_HEALTH_URL: base },
    });

    expect(passing.code).toBe(0);
    const json = JSON.parse(passing.out) as { summary: unknown; checks: { scope: string }[] };
    expect(json.summary).toEqual({ ok: 1, warn: 0, fail: 0 });
    expect(json.checks.map((c) => c.scope)).toEqual(["office"]);
  });

  it("says where the office is not known or does not answer", async () => {
    const none = await ost(["doctor", "--via-office"]);
    expect([none.code, none.err]).toEqual([
      1,
      expect.stringContaining("Set OUTSTAFF_OFFICE_HEALTH_URL"),
    ]);

    const bad = await ost(["doctor", "--via-office"], {
      env: { OUTSTAFF_OFFICE_URL: "not a url" },
    });

    expect(bad.err).toContain('OUTSTAFF_OFFICE_URL "not a url" is not a URL.');

    const missing = await ost(["doctor", "--via-office"], {
      env: { OUTSTAFF_OFFICE_HEALTH_URL: `${base}/nothing-here` },
    });

    expect(missing.err).toContain(
      "answered 404 without the checks. Set OUTSTAFF_OFFICE_HEALTH_URL",
    );

    const down = await ost(["doctor", "--via-office"], {
      env: { OUTSTAFF_OFFICE_URL: "wss://office.acme.example/agent" },
      fetch: () => Promise.reject(new Error("refused")),
    });

    expect(down.err).toBe("https://office.acme.example/doctor did not answer (refused).\n");
  });
});
