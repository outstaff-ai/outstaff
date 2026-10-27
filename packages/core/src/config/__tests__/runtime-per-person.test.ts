import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  clearAdapterOptions,
  integrationsFor,
  parseTeamConfig,
  registerAdapterOptions,
  runtimeOf,
  teamFor,
  validateAdapterOptions,
  validateTeam,
} from "#/index.js";
import type {
  AdapterInfo,
  Capability,
  RoleNeeds,
  TeamConfig,
  TeamConfigInput,
  ValidationContext,
} from "#/index.js";

const adapter = (
  port: AdapterInfo["port"],
  name: string,
  capabilities: Capability[],
): [string, AdapterInfo] => [`${port}/${name}`, { port, name, capabilities }];

/** Two runtimes: the full one the team defaults to, and a bare stand-in that provides nothing. */
const RUNTIMES = new Map([
  adapter("runtime", "claude-agent-sdk", [
    "runtime.sessions",
    "runtime.usage",
    "runtime.permissions",
    "design.canvas",
  ]),
  adapter("runtime", "acme-bare", []),
  adapter("runtime", "acme-lite", ["runtime.permissions", "runtime.usage"]),
]);

const ROLES = new Map<string, RoleNeeds>([
  ["developer", { needs: [] }],
  ["designer", { needs: [], optionalNeeds: ["design.canvas"] }],
  ["canvas-lead", { needs: ["design.canvas"] }],
]);

/** Errors about runtimes; with only runtimes known, the chat and vcs adapters are unknown too. */
const runtimeErrors = (report: ReturnType<typeof validateTeam>) =>
  report.errors.filter((e) => e.path.includes("runtime"));

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  roles: ROLES,
  adapters: new Map(),
  adapterCapabilities: RUNTIMES,
  ...over,
});

function team(people: Record<string, unknown>[], extra: Record<string, unknown> = {}): TeamConfig {
  const input = {
    version: 1,
    team: { name: "acme" },
    humans: [{ name: "Alex", identities: { vcs: "alex" } }],
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
    people: people.map((p) => ({ name: String(p["handle"]), repos: {}, ...p })),
    integrations: {
      chat: { adapter: "slack" },
      vcs: { adapter: "github" },
      runtime: { adapter: "claude-agent-sdk", model: "sonnet" },
    },
    ...extra,
  };

  const r = parseTeamConfig(input as unknown as TeamConfigInput);
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
}

const runtimeCodes = (report: ReturnType<typeof validateTeam>) => ({
  errors: report.errors.map((e) => [e.path, e.code, e.message]),
  warnings: report.warnings
    .filter((w) => w.code.startsWith("people.runtime") || w.code.startsWith("capability."))
    .map((w) => [w.path, w.code, w.message]),
});

describe("runtimeOf", () => {
  const t = team([
    { handle: "sam", role: "developer" },
    { handle: "noor", role: "developer", runtime: { adapter: "acme-lite", tier: "fast" } },
  ]);

  it("is the person's own runtime, else the team's", () => {
    expect(runtimeOf(t, t.people[0])).toEqual({ adapter: "claude-agent-sdk", model: "sonnet" });
    expect(runtimeOf(t, t.people[1])).toEqual({ adapter: "acme-lite", tier: "fast" });
    expect(runtimeOf(t, undefined).adapter).toBe("claude-agent-sdk");
  });

  it("gives each person the team with their own runtime, replaced as a whole", () => {
    expect(integrationsFor(t, t.people[1]).runtime).toEqual({ adapter: "acme-lite", tier: "fast" });
    expect(integrationsFor(t, t.people[1]).chat).toEqual({ adapter: "slack" });
    expect(teamFor(t, t.people[0])).toBe(t);
    expect(teamFor(t, t.people[1]).integrations.runtime.adapter).toBe("acme-lite");
    expect(teamFor(t, t.people[1]).people).toBe(t.people);
  });
});

describe("validateTeam: runtime per person", () => {
  it("is quiet for people on runtimes that provide what they need", () => {
    const t = team([
      { handle: "sam", role: "designer" },
      { handle: "noor", role: "developer", runtime: { adapter: "acme-lite" } },
    ]);

    expect(runtimeCodes(validateTeam(t, ctx()))).toEqual({ errors: [], warnings: [] });
  });

  it("names the person whose runtime cannot enforce the permission policy or report usage", () => {
    const t = team([
      { handle: "sam", role: "developer" },
      { handle: "noor", role: "developer", runtime: { adapter: "acme-bare" } },
    ]);

    expect(runtimeCodes(validateTeam(t, ctx()))).toEqual({
      errors: [
        [
          ["people", 1, "runtime"],
          "people.runtime_missing_capability",
          'noor runs on runtime "acme-bare", which does not provide runtime.permissions: it cannot run under its permission policy.',
        ],
      ],
      warnings: [
        [
          ["people", 1, "runtime"],
          "people.runtime_without_usage",
          'noor runs on runtime "acme-bare", which reports no usage windows.',
        ],
      ],
    });
  });

  it("checks the team's runtime for people without their own", () => {
    const t = team([{ handle: "sam", role: "developer" }], {
      integrations: {
        chat: { adapter: "slack" },
        vcs: { adapter: "github" },
        runtime: { adapter: "acme-bare" },
      },
    });

    expect(validateTeam(t, ctx()).errors.map((e) => [e.path, e.code])).toEqual([
      [["people", 0, "role"], "people.runtime_missing_capability"],
    ]);
  });

  it("errors on a needed runtime capability and warns on an optional one, per person", () => {
    const t = team([
      { handle: "leo", role: "designer", runtime: { adapter: "acme-lite" } },
      {
        handle: "ines",
        role: "developer",
        extends: ["canvas-lead"],
        runtime: { adapter: "acme-lite" },
      },
      { handle: "sam", role: "canvas-lead" },
    ]);

    expect(runtimeCodes(validateTeam(t, ctx()))).toEqual({
      errors: [
        [
          ["people", 1, "runtime"],
          "people.runtime_missing_capability",
          'Role "canvas-lead" needs design.canvas, which runtime "acme-lite" of ines does not provide.',
        ],
      ],
      warnings: [
        [
          ["people", 0, "runtime"],
          "capability.optional_missing",
          'Role "designer" can use design.canvas, which runtime "acme-lite" of leo does not provide.',
        ],
      ],
    });
  });

  it("does not warn about the canvas when the team switched it off", () => {
    const t = team([{ handle: "leo", role: "designer", runtime: { adapter: "acme-lite" } }], {
      policies: { design: { canvas: false } },
    });

    expect(runtimeCodes(validateTeam(t, ctx())).warnings).toEqual([]);
  });

  it("errors on a person's unknown runtime only when the host knows its adapters", () => {
    const t = team([{ handle: "noor", role: "developer", runtime: { adapter: "acme-gone" } }]);
    expect(validateTeam(t, ctx()).errors).toEqual([]);

    const known = { roles: ROLES, adapters: RUNTIMES };
    expect(runtimeErrors(validateTeam(t, known)).map((e) => [e.path, e.code, e.message])).toEqual([
      [
        ["people", 0, "runtime", "adapter"],
        "integrations.unknown_adapter",
        'No runtime adapter named "acme-gone" is installed for noor.',
      ],
    ]);
  });

  it("does not report a person on an unknown team runtime twice", () => {
    const t = team([{ handle: "noor", role: "developer" }], {
      integrations: {
        chat: { adapter: "slack" },
        vcs: { adapter: "github" },
        runtime: { adapter: "acme-gone" },
      },
    });

    const known = { roles: ROLES, adapters: RUNTIMES };
    expect(runtimeErrors(validateTeam(t, known)).map((e) => e.path)).toEqual([
      ["integrations", "runtime", "adapter"],
    ]);
  });
});

describe("policies.usage.shared and runtimes", () => {
  const people = [
    { handle: "sam", role: "developer" },
    { handle: "noor", role: "developer" },
    { handle: "ines", role: "developer", runtime: { adapter: "acme-lite" } },
    { handle: "kofi", role: "developer", runtime: { adapter: "acme-lite", tier: "fast" } },
  ];

  const parse = (shared: string[][]) => {
    const input = {
      version: 1,
      team: { name: "acme" },
      catalog: { version: "1.0.0" },
      repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
      people: people.map((p) => ({ name: p.handle, ...p })),
      integrations: {
        chat: { adapter: "slack" },
        vcs: { adapter: "github" },
        runtime: { adapter: "claude-agent-sdk" },
      },
      policies: { usage: { shared } },
    };

    return parseTeamConfig(input as unknown as TeamConfigInput);
  };

  it("accepts groups whose members run on one runtime", () => {
    expect(
      parse([
        ["sam", "noor"],
        ["ines", "kofi"],
      ]).ok,
    ).toBe(true);
  });

  it("rejects a group that mixes runtimes, naming the person", () => {
    const r = parse([["sam", "ines", "noor"]]);
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.issues).toEqual([
      {
        path: ["policies", "usage", "shared", 0, 1],
        code: "policies.usage_shared_mixed_runtime",
        message:
          '"ines" runs on runtime "acme-lite" but "sam" in the same usage group runs on "claude-agent-sdk"; a group shares one credential, so one runtime.',
      },
    ]);
  });
});

describe("adapter options of a person's runtime", () => {
  afterEach(() => clearAdapterOptions());

  it("are checked against the adapter's schema at the person's path", () => {
    registerAdapterOptions("runtime", "acme-lite", z.strictObject({ tier: z.enum(["fast"]) }));
    const t = team([
      { handle: "sam", role: "developer" },
      { handle: "noor", role: "developer", runtime: { adapter: "acme-lite", tier: "slow" } },
      { handle: "ines", role: "developer", runtime: { adapter: "acme-lite", tier: "fast" } },
    ]);

    expect(validateAdapterOptions(t)).toEqual([
      {
        path: ["people", 1, "runtime", "tier"],
        code: "integrations.invalid_options",
        message: expect.any(String),
      },
    ]);
  });
});
