import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSecretSource, silentLogger } from "@outstaff/core";
import { createFakeAdapterRegistry } from "@outstaff/core/fakes";
import { afterEach, describe, expect, it } from "vitest";
import { startOffice, type RunningOffice } from "./main.js";

const TEAM = `
version: 1
team: { name: acme }
catalog: { version: 1.0.0 }
repos:
  - { name: app, url: git.acme.example/acme/app, kind: primary }
people:
  - { handle: sam, name: Sam, role: developer }
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
    running = await startOffice(env(), deps);
    const base = `http://127.0.0.1:${running.health.port()}`;
    const live = await fetch(`${base}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true, state: "running" });
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(404);

    await running.office.stop();
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
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
