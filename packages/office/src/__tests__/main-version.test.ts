import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSecretSource, silentLogger } from "@outstaff/core";
import { createFakeAdapterRegistry } from "@outstaff/core/fakes";
import { afterEach, describe, expect, it } from "vitest";
import { FakeService, until } from "#/link/__tests__/service.js";
import { startOffice } from "#/main.js";
import type { RunningOffice } from "#/types.js";

const team = (link: string) => `
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
link: { url: "${link}" }
`;

const packageVersion = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

describe("the version the office reports", () => {
  let running: RunningOffice | undefined;
  let dash: FakeService | undefined;
  afterEach(async () => {
    await running?.stop();
    await dash?.close();
    running = undefined;
    dash = undefined;
  });

  /** Starts the office from the environment and returns the version its link's hello carries. */
  async function hello(extra: Record<string, string>) {
    dash = new FakeService("dash-token");
    await dash.ready();
    const dir = mkdtempSync(join(tmpdir(), "office-version-"));
    writeFileSync(join(dir, "team.yaml"), team(dash.url));
    running = await startOffice(
      {
        OUTSTAFF_TEAM_FILE: join(dir, "team.yaml"),
        OUTSTAFF_STORE_URL: "sqlite::memory:",
        OUTSTAFF_AGENT_PORT: "0",
        OUTSTAFF_HEALTH_PORT: "0",
        ...extra,
      },
      {
        registry: createFakeAdapterRegistry(),
        secrets: envSecretSource(
          { OUTSTAFF_AGENT_TOKEN_SAM: "t", OUTSTAFF_LINK_TOKEN: "dash-token" },
          "/nonexistent",
        ),
        logger: silentLogger,
      },
    );

    await until(() => dash!.links.length === 1);
    dash.welcome();
    await until(() => dash!.of("hello").length === 1);
    return dash.of("hello")[0]!.payload.office.version;
  }

  it("is the image's OUTSTAFF_VERSION", async () => {
    expect(await hello({ OUTSTAFF_VERSION: "0.1.0-rc.20" })).toBe("0.1.0-rc.20");
  });

  it("is the package's version without OUTSTAFF_VERSION, or with it empty", async () => {
    expect(await hello({})).toBe(packageVersion);
    await running!.stop();
    await dash!.close();
    expect(await hello({ OUTSTAFF_VERSION: "" })).toBe(packageVersion);
  });
});
