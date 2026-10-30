import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSecretSource, parseTeamConfig, parseYaml, silentLogger } from "@outstaff/core";
import { createFakeAdapterRegistry } from "@outstaff/core/fakes";
import { afterEach, describe, expect, it } from "vitest";
import { jsonLogger, logLevel, officeRegistry, startOffice } from "#/main.js";
import type { RunningOffice } from "#/types.js";

const TEAM = `
version: 1
team: { name: acme }
catalog: { version: 1.0.0 }
repos:
  - { name: app, url: git.acme.example/acme/app, kind: primary }
people:
  - { handle: sam, name: Sam, role: developer, model: sonnet }
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
      checks: [{ scope: "office", name: "OUTSTAFF_AGENT_TOKEN_SAM present", status: "ok" }],
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
