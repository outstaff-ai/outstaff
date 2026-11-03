import { describe, expect, it } from "vitest";
import { parseTeamConfig, validateTeam } from "#/index.js";
import type { AdapterInfo, Capability, TeamConfigInput, ValidationContext } from "#/index.js";

const ctx = (knowledge: Capability[] | undefined): ValidationContext => ({
  roles: new Map(),
  adapters: new Map<string, AdapterInfo>(
    knowledge ? [["knowledge/kb", { port: "knowledge", name: "kb", capabilities: knowledge }]] : [],
  ),
});

const team = (memory: unknown, knowledge = true) => {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
    people: [],
    integrations: {
      chat: { adapter: "slack" },
      vcs: { adapter: "github" },
      runtime: { adapter: "claude-agent-sdk" },
      ...(knowledge ? { knowledge: { adapter: "kb" } } : {}),
    },
    ...(memory === undefined ? {} : { memory }),
  } as TeamConfigInput);

  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
};

const codes = (config: ReturnType<typeof team>, c: ValidationContext) =>
  validateTeam(config, c)
    .errors.filter((e) => e.path[0] === "memory")
    .map((e) => [e.path.join("."), e.code, e.message]);

describe("memory.store", () => {
  it("defaults to the volume, which needs nothing", () => {
    expect(team({}).memory?.store).toBe("volume");
    expect(team(undefined).memory).toBeUndefined();
    expect(codes(team(undefined, false), ctx(undefined))).toEqual([]);
  });

  it("keeps notes in a knowledge integration that provides knowledge.notes", () => {
    expect(codes(team({ store: "knowledge" }), ctx(["knowledge.notes"]))).toEqual([]);
  });

  it("refuses knowledge without a knowledge integration, or one without notes", () => {
    expect(codes(team({ store: "knowledge" }, false), ctx(undefined))).toEqual([
      [
        "memory.store",
        "memory.store_unsupported",
        "memory.store is knowledge, but no knowledge integration is configured. Configure integrations.knowledge or use store: volume.",
      ],
    ]);

    expect(codes(team({ store: "knowledge" }), ctx(["knowledge.docs"]))).toEqual([
      [
        "memory.store",
        "memory.store_unsupported",
        'memory.store is knowledge, but the knowledge adapter "kb" does not provide knowledge.notes. Use store: volume.',
      ],
    ]);

    // Without the installed adapters the capability cannot be checked.
    expect(codes(team({ store: "knowledge" }), { roles: new Map(), adapters: new Map() })).toEqual(
      [],
    );
  });
});
