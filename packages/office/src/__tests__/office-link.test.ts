import { parseTeamConfig, type TeamConfig } from "@outstaff/core";
import { createFakeKnowledge, createFakeTracker, createFakeVcs } from "@outstaff/core/fakes";
import { describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import type { OfficeLink } from "#/link/index.js";
import { createLinkForOffice, linkHealth, subjectLinks } from "#/office-link.js";
import type { CreateOfficeInput } from "#/office.types.js";
import type { ProtocolServer } from "#/protocol/index.js";
import { openStore } from "#/store/index.js";
import type { OfficePorts } from "#/types.js";

function team(link?: string, pipeline?: "shadow"): TeamConfig {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "shop", url: "git.acme.example/acme/shop", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer" }],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
    },
    ...(link ? { link: { url: link } } : {}),
    ...(pipeline ? { office: { pipeline } } : {}),
  });

  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
}

const vcsOnly = (): OfficePorts => ({ vcs: createFakeVcs() }) as unknown as OfficePorts;
const protocol = { connected: () => [] } as unknown as ProtocolServer;

describe("office link wiring", () => {
  it("links pull requests always, and tickets and documents when the office has those ports", () => {
    const bare = subjectLinks(vcsOnly());
    expect(bare.pr?.({ repo: { host: "h", owner: "acme", name: "shop" }, number: 3 })).toEqual(
      expect.any(String),
    );

    expect(bare.ticket).toBeUndefined();
    expect(bare.doc).toBeUndefined();

    const full = subjectLinks({
      ...vcsOnly(),
      tracker: createFakeTracker(),
      knowledge: createFakeKnowledge(),
    } as unknown as OfficePorts);

    expect(full.ticket?.("ACME-123")).toEqual(expect.any(String));
    expect(full.doc?.("d1")).toEqual(expect.any(String));
  });

  it("shows the link's state, and its last error, without failing the office", () => {
    const link = (lastError?: string) =>
      ({ status: () => ({ state: "backoff", ...(lastError ? { lastError } : {}) }) }) as OfficeLink;

    expect(linkHealth(link())).toEqual({ ok: true, detail: "backoff" });
    expect(linkHealth(link("refused"))).toEqual({ ok: true, detail: "backoff; refused" });
  });

  it("connects to none without the team file's link or the token", async () => {
    const store = await openStore("sqlite::memory:");
    const input = (t: TeamConfig, token?: string) =>
      ({
        team: t,
        store,
        clock: manualClock(),
        secrets: { get: (key: string) => (key === "OUTSTAFF_LINK_TOKEN" ? token : undefined) },
      }) as unknown as CreateOfficeInput;

    const make = (t: TeamConfig, token?: string, officeVersion?: string) =>
      createLinkForOffice({
        input: { ...input(t, token), ...(officeVersion ? { options: { officeVersion } } : {}) },
        ports: vcsOnly(),
        protocol,
        doctor: { run: async () => {}, health: async () => ({}) as never },
        log: { debug() {}, info() {}, warn() {}, error() {} } as never,
      });

    expect(make(team(), "t")).toBeUndefined();
    expect(make(team("ws://127.0.0.1:1/link"))).toBeUndefined();
    expect(make(team("ws://127.0.0.1:1/link"), "t")?.status().state).toBe("idle");
    expect(make(team("ws://127.0.0.1:1/link", "shadow"), "t", "1.2.3")?.status().state).toBe(
      "idle",
    );

    await store.close();
  });
});
