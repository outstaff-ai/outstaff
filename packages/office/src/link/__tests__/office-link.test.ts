import {
  AdapterRegistry,
  envSecretSource,
  parseTeamConfig,
  type PortName,
  type TeamConfig,
} from "@outstaff/core";
import {
  createFakeAdapterRegistry,
  createFakeChat,
  createFakeTracker,
  createFakeVcs,
} from "@outstaff/core/fakes";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { createOffice } from "#/office.js";
import type { Office } from "#/office.types.js";
import { openStore } from "#/store/index.js";
import { FakeService, until } from "./service.js";

function team(url?: string): TeamConfig {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "shop", url: "git.acme.example/acme-example/shop", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer", model: "sonnet" }],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
    ...(url ? { link: { url } } : {}),
  });

  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
}

describe("the office's office link", () => {
  const clock = manualClock();
  let office: Office | undefined;
  let dash: FakeService | undefined;

  afterEach(async () => {
    await office?.stop();
    await dash?.close();
    office = undefined;
    dash = undefined;
  });

  async function start(config: TeamConfig, secrets: Record<string, string>) {
    const stock = createFakeAdapterRegistry();
    const instances = {
      vcs: createFakeVcs({ now: clock.now }),
      tracker: createFakeTracker({ now: clock.now }),
      chat: createFakeChat({ now: clock.now }),
    } as Record<string, unknown>;

    const registry = new AdapterRegistry();
    for (const port of ["vcs", "tracker", "chat"] as PortName[]) {
      registry.register({ ...stock.get(port, "fake")!, create: () => instances[port] as never });
    }

    office = await createOffice({
      team: config,
      registry,
      secrets: envSecretSource(
        { OUTSTAFF_AGENT_TOKEN_SAM: "sam-token", ...secrets },
        "/nonexistent",
      ),
      store: await openStore("sqlite::memory:", { now: () => clock.now() }),
      clock,
      options: { agentPort: 0, agentHost: "127.0.0.1" },
    });

    await office.start();
  }

  it("connects out to the service the team file names, and shows the link in its health", async () => {
    dash = new FakeService("dash-token");
    await dash.ready();
    await start(team(dash.url), { OUTSTAFF_LINK_TOKEN: "dash-token" });
    await until(() => dash!.links.length === 1);
    dash.welcome();
    await until(() => dash!.of("people").length === 1);
    expect(dash.of("people")[0]!.payload.people.map((p) => p.handle)).toEqual(["sam"]);
    expect(dash.of("hello")[0]!.payload.office).toEqual({
      team: "acme",
      version: "unknown",
    });

    const health = await office!.health();
    expect(health.components["link"]).toEqual({ ok: true, detail: "connected" });
    expect(health.ok).toBe(true);

    dash.refuse = true;
    dash.last.ws.terminate();
    await until(() => office!.parts.link!.status().state === "backoff");
    clock.advance(1000);
    await until(() => office!.parts.link!.status().lastError !== undefined);
    const down = await office!.health();
    expect(down.components["link"]!.detail).toMatch(
      /^(backoff|connecting); connection failed: .*401/,
    );

    expect(down.ok).toBe(true);
  });

  it("has no link without the URL or without the token", async () => {
    await start(team(), { OUTSTAFF_LINK_TOKEN: "dash-token" });
    expect(office!.parts.link).toBeUndefined();
    expect((await office!.health()).components).not.toHaveProperty("link");
    await office!.stop();
    await start(team("wss://ops.acme.example/link"), {});
    expect(office!.parts.link).toBeUndefined();
  });
});
