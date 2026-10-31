import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { envSecretSource, parseTeamConfig, parseYaml, silentLogger } from "@outstaff/core";
import { createFakeAdapterRegistry } from "@outstaff/core/fakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonLogger, logLevel, officeRegistry, pollInterval, startOffice } from "#/main.js";
import type { RunningOffice } from "#/types.js";

const TEAM = `
version: 1
team: { name: acme }
catalog: { version: 1.0.0 }
repos:
  - { name: app, url: git.acme.example/acme/app, kind: primary }
people:
  - { handle: sam, name: Sam, role: developer, model: sonnet, repos: { app: write } }
integrations:
  chat: { adapter: fake }
  vcs: { adapter: fake }
  runtime: { adapter: fake }
  tracker: { adapter: fake }
`;

describe("startOffice", () => {
  let running: RunningOffice | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  const env = (extra: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "office-main-"));
    writeFileSync(join(dir, "team.yaml"), TEAM);
    return {
      OUTSTAFF_TEAM_FILE: join(dir, "team.yaml"),
      OUTSTAFF_STORE_URL: "sqlite::memory:",
      OUTSTAFF_AGENT_PORT: "0",
      OUTSTAFF_HEALTH_PORT: "0",
      ...extra,
    };
  };

  const deps = {
    registry: createFakeAdapterRegistry(),
    secrets: envSecretSource({ OUTSTAFF_AGENT_TOKEN_SAM: "t" }, "/nonexistent"),
    logger: silentLogger,
  };

  it("starts from the environment, answers the probes and stops", async () => {
    running = await startOffice(env({ OUTSTAFF_SECRETS_DIR: "/nonexistent" }), deps);
    const base = `http://127.0.0.1:${running.health.port()}`;
    const live = await fetch(`${base}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true, state: "running" });
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const ran = await fetch(`${base}/doctor`, { method: "POST" });
    expect(ran.status).toBe(200);
    expect(await ran.json()).toMatchObject({
      lastRun: expect.any(String),
      checks: [
        // The fake tracker links pull requests, and the team's repository is not connected to it.
        { scope: "office", name: "Tracker link of app", status: "warn" },
        { scope: "office", name: "OUTSTAFF_AGENT_TOKEN_SAM present", status: "ok" },
      ],
    });

    expect((await fetch(`${base}/doctor`)).status).toBe(200);
    expect((await fetch(`${base}/doctor`, { method: "DELETE" })).status).toBe(404);

    await running.office.stop();
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  });

  it("reads the code host's merge rules in the office's doctor runs", async () => {
    const merging = env({ OUTSTAFF_SECRETS_DIR: "/nonexistent" });
    writeFileSync(
      merging.OUTSTAFF_TEAM_FILE,
      `${TEAM}policies:\n  merge: { on_approval: true, repos: [app] }\n`,
    );

    running = await startOffice(merging, deps);
    const base = `http://127.0.0.1:${running.health.port()}`;
    const ran = await fetch(`${base}/doctor`, { method: "POST" });
    expect(((await ran.json()) as { checks: unknown[] }).checks).toContainEqual(
      expect.objectContaining({ scope: "office", name: "Merge gate of app", status: "fail" }),
    );
  });

  it("explains a team file that is not valid", async () => {
    const bad = env();
    writeFileSync(bad.OUTSTAFF_TEAM_FILE, "version: 2\n");
    await expect(startOffice(bad, deps)).rejects.toThrow("team.yaml is not valid");
  });

  it("polls on OUTSTAFF_POLL_INTERVAL_MS, says so, and shows the polls in the health answer", async () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (m: string) => void warnings.push(m) };
    running = await startOffice(env({ OUTSTAFF_POLL_INTERVAL_MS: "20" }), { ...deps, logger });
    expect(warnings).toContain(
      "OUTSTAFF_POLL_INTERVAL_MS overrides office.poll_interval_seconds; it is meant for tests",
    );

    const base = `http://127.0.0.1:${running.health.port()}`;
    const polls = async () =>
      (
        (await (await fetch(`${base}/healthz`)).json()) as {
          components: { intake: { polls: Record<string, { count: number; last: string }> } };
        }
      ).components.intake.polls;

    // The default interval is a minute: a third poll within the test's time comes from the override.
    await vi.waitFor(async () => expect((await polls())["vcs"]?.count).toBeGreaterThan(2));
    expect((await polls())["tracker"]).toEqual({
      count: expect.any(Number),
      last: expect.any(String),
    });

    expect(Date.parse((await polls())["vcs"]!.last)).toBeGreaterThan(0);
  });

  it("rejects a poll interval that is not a positive whole number", async () => {
    expect(pollInterval({})).toEqual({});
    expect(pollInterval({ OUTSTAFF_POLL_INTERVAL_MS: "" })).toEqual({});
    expect(pollInterval({ OUTSTAFF_POLL_INTERVAL_MS: "1000" })).toEqual({ pollIntervalMs: 1000 });
    for (const bad of ["0", "-5", "1.5", "fast"]) {
      expect(() => pollInterval({ OUTSTAFF_POLL_INTERVAL_MS: bad })).toThrow(
        `OUTSTAFF_POLL_INTERVAL_MS must be a positive whole number, got "${bad}".`,
      );
    }
  });

  it("loads the team's custom policies, which run after the built-in ones", async () => {
    const custom = env({ OUTSTAFF_SECRETS_DIR: "/nonexistent" });
    const dir = dirname(custom.OUTSTAFF_TEAM_FILE);
    writeFileSync(
      join(dir, "freeze.mjs"),
      `export const policy = { id: "freeze", summary: "s", on: ["agent.idle"], decide: () => [{ type: "drop", reason: "frozen" }] };\n`,
    );

    writeFileSync(
      custom.OUTSTAFF_TEAM_FILE,
      `${TEAM}policies:\n  custom:\n    - { module: ./freeze.mjs, settings: { until: "2026-12-01" } }\n`,
    );

    running = await startOffice(custom, deps);
    const trace = await running.office.parts.pipeline.judge({
      id: "office:idle:sam:1",
      type: "agent.idle",
      at: "2026-10-05T09:00:00.000Z",
      subject: {},
      actor: { kind: "agent", id: "sam" },
      data: {},
    });

    expect(trace.policies.at(-1)).toMatchObject({
      policy: "freeze",
      proposals: [{ type: "drop", reason: "frozen" }],
    });
  });

  it("does not start with a custom policy it cannot load", async () => {
    const broken = env();
    writeFileSync(
      broken.OUTSTAFF_TEAM_FILE,
      `${TEAM}policies:\n  custom:\n    - module: ./missing.mjs\n`,
    );

    await expect(startOffice(broken, deps)).rejects.toThrow(
      /a custom policy cannot be loaded:\npolicies.custom\[0\]: \.\/missing\.mjs: cannot be loaded/,
    );
  });

  it("rejects a port that is not a number", async () => {
    await expect(startOffice(env({ OUTSTAFF_AGENT_PORT: "abc" }), deps)).rejects.toThrow(
      "OUTSTAFF_AGENT_PORT",
    );
  });
});

describe("the acme example", () => {
  it("parses the options of every integration the office can create", () => {
    const file = new URL("../../../../examples/acme/.outstaff/team.yaml", import.meta.url);
    const parsed = parseTeamConfig(parseYaml(readFileSync(file, "utf8")).value);
    if (!parsed.ok) {
      throw new Error("the acme example does not parse");
    }

    const registry = officeRegistry();
    let checked = 0;
    for (const [port, ref] of Object.entries(parsed.config.integrations)) {
      if (!ref) {
        continue;
      }

      const def = registry.list().find((d) => d.port === port && d.name === ref.adapter);
      if (!def) {
        continue;
      }

      const { adapter: _adapter, ...options } = ref;
      expect(def.options.safeParse(options).success, `integrations.${port}`).toBe(true);
      checked += 1;
    }

    expect(checked).toBeGreaterThanOrEqual(3);
  });
});

describe("jsonLogger", () => {
  it("hides debug by default and writes it at the debug level", () => {
    const lines: string[] = [];
    const quiet = jsonLogger((l) => void lines.push(l));
    quiet.debug("hidden");
    quiet.info("shown");
    expect(lines.map((l) => JSON.parse(l).message)).toEqual(["shown"]);

    const loud = jsonLogger((l) => void lines.push(l), logLevel({ OUTSTAFF_LOG_LEVEL: "debug" }));
    loud.debug("now shown");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      level: "debug",
      message: "now shown",
    });
  });

  it("rejects an unknown level", () => {
    expect(() => logLevel({ OUTSTAFF_LOG_LEVEL: "loud" })).toThrow(/OUTSTAFF_LOG_LEVEL/);
    expect(logLevel({})).toBe("info");
  });
});
