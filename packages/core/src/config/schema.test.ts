import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildTeamJsonSchema,
  clearAdapterOptions,
  parseTeamConfig,
  registerAdapterOptions,
  validateAdapterOptions,
  type TeamConfigInput,
} from "../index.js";

const valid = (): TeamConfigInput => ({
  version: 1,
  team: { name: "acme", product: "Acme Cloud", description: "The Acme product team." },
  humans: [
    { name: "Alex Doe", identities: { vcs: "alex-doe", chat: "U123", email: "alex@acme.example" } },
  ],
  catalog: { version: "1.0.0" },
  repos: [
    { name: "app", url: "github.com/acme/app", kind: "primary" },
    {
      name: "standards",
      url: "https://github.com/acme/standards",
      kind: "baseline",
      default_branch: "trunk",
    },
    { name: "infra", url: "git@github.com:acme/infra.git", kind: "infra" },
  ],
  people: [
    {
      handle: "ada",
      name: "Ada",
      pronouns: "she/her",
      role: "backend-engineer",
      repos: { app: "write", "kind:baseline": "read" },
    },
    {
      handle: "bo",
      name: "Bo",
      role: "frontend-engineer",
      extends: ["a11y"],
      model: "sonnet",
      repos: { app: "write" },
    },
    {
      handle: "cy",
      name: "Cy",
      role: "qa-engineer",
      repos: { "*": "read" },
      avatar: { seed: "cy" },
    },
    {
      handle: "di",
      name: "Di",
      role: "devops-engineer",
      repos: { infra: "write", "kind:infra": "write" },
    },
    {
      handle: "ed",
      name: "Ed",
      role: "tech-writer",
      repos: {},
      avatar: { url: "https://acme.example/ed.png" },
    },
  ],
  integrations: {
    chat: { adapter: "slack" },
    vcs: { adapter: "github" },
    runtime: { adapter: "claude-agent-sdk" },
    tracker: { adapter: "linear", project: "ACME" },
    knowledge: { adapter: "notion" },
    avatars: { adapter: "dicebear" },
  },
  email: { pattern: "{handle}@acme.example" },
  office: { events: "webhook", poll_interval_seconds: 30 },
  workflow: {
    preset: "scrum",
    statuses: { review: "In Review" },
    rules: [{ id: "x", on: "pr.opened", do: [{ move: "review" }] }],
  },
  policies: {
    agent_loop_guard: { max_runs_per_item_per_hour: 6 },
    usage: { defer_scheduled_at: 0.5, pause_automatic_at: 0.9 },
    messages: { max_lines: 5, always_link: false, omit: ["ci"] },
  },
});

const bad = (mutate: (c: any) => void) => {
  const c: any = valid();
  mutate(c);
  const r = parseTeamConfig(c);
  if (r.ok) {
    throw new Error("expected failure");
  }

  return r.issues;
};

describe("parseTeamConfig", () => {
  it("accepts a full config", () => {
    expect(parseTeamConfig(valid()).ok).toBe(true);
  });

  it("applies defaults", () => {
    const r = parseTeamConfig({
      version: 1,
      team: { name: "acme" },
      catalog: { version: "1.0.0" },
      repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
      people: [{ handle: "ada", name: "Ada", role: "r" }],
      integrations: { chat: { adapter: "a" }, vcs: { adapter: "b" }, runtime: { adapter: "c" } },
      office: {},
      workflow: {},
      policies: {},
    });

    if (!r.ok) {
      throw new Error(JSON.stringify(r.issues));
    }

    expect(r.config.catalog.path).toBe("catalog");
    expect(r.config.repos[0]?.default_branch).toBe("main");
    expect(r.config.people[0]?.repos).toEqual({});
    expect(r.config.office).toEqual({ events: "poll", poll_interval_seconds: 60 });
    expect(r.config.workflow?.preset).toBe("kanban");
    expect(r.config.policies).toEqual({
      agent_loop_guard: { max_runs_per_item_per_hour: 12 },
      usage: { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 },
      acknowledge: { chat: true, vcs: true },
      feedback: {
        follow_up_round: true,
        merged_prs: true,
        doc_comments: true,
        ticket_comments: true,
      },
      hand_back: { reassign: "requester", fallback: "first_human" },
      tickets: { prs_per_ticket: "one" },
      conflicts: { follow_up: true },
      merge: { on_approval: false, approvers: ["humans"] },
      retry: { on_signal: true, base_minutes: 1, cap_minutes: 30, max_failures: 3 },
      messages: { max_lines: 3, always_link: true, omit: ["ci", "mergeability", "hashes"] },
      chat: { parallel_sessions: 2, profile: true },
      design: { canvas: true },
    });
  });

  it("keeps what the team sets in policies and fills the rest with defaults", () => {
    const r = parseTeamConfig({
      ...valid(),
      policies: { acknowledge: { vcs: false }, hand_back: { reassign: "none" } },
    });

    if (!r.ok) {
      throw new Error(JSON.stringify(r.issues));
    }

    expect(r.config.policies?.acknowledge).toEqual({ chat: true, vcs: false });
    expect(r.config.policies?.hand_back).toEqual({ reassign: "none", fallback: "first_human" });
    expect(r.config.policies?.conflicts).toEqual({ follow_up: true });
  });

  it("rejects an unknown switch and a value outside a switch's choices", () => {
    expect(bad((c) => (c.policies = { acknowledge: { slack: true } }))).toEqual([
      expect.objectContaining({
        path: ["policies", "acknowledge", "slack"],
        code: "schema.unknown_key",
      }),
    ]);

    expect(bad((c) => (c.policies = { review: { on_approval: true } }))).toEqual([
      expect.objectContaining({ path: ["policies", "review"], code: "schema.unknown_key" }),
    ]);

    expect(bad((c) => (c.policies = { hand_back: { reassign: "everyone" } }))[0]).toMatchObject({
      path: ["policies", "hand_back", "reassign"],
    });
  });

  it("accepts policies.merge and rejects a bad approver, method or repo", () => {
    const ok = parseTeamConfig({
      ...valid(),
      policies: {
        merge: {
          on_approval: true,
          approvers: ["humans", "human:ada", "role:reviewer", "acme-rex"],
          method: "squash",
          repos: ["app"],
        },
      },
    });

    expect(ok.ok).toBe(true);
    expect(bad((c) => (c.policies = { merge: { approvers: ["role:Bad Role"] } }))[0]).toMatchObject(
      { path: ["policies", "merge", "approvers", 0] },
    );

    expect(bad((c) => (c.policies = { merge: { method: "rebase" } }))[0]).toMatchObject({
      path: ["policies", "merge", "method"],
    });

    expect(bad((c) => (c.policies = { merge: { repos: ["nope"] } }))).toEqual([
      expect.objectContaining({
        path: ["policies", "merge", "repos", 0],
        code: "policies.merge_unknown_repo",
      }),
    ]);
  });

  it("reports wrong types with the exact path", () => {
    expect(bad((c) => (c.team.name = 5))).toEqual([
      { path: ["team", "name"], code: "schema.invalid_type", message: expect.any(String) },
    ]);
  });

  it("rejects unsupported versions", () => {
    expect(bad((c) => (c.version = 2))[0]).toMatchObject({
      path: ["version"],
      code: "schema.invalid_value",
    });
  });

  it("reports unknown keys one by one", () => {
    expect(bad((c) => (c.repos[1].colour = "red"))).toEqual([
      { path: ["repos", 1, "colour"], code: "schema.unknown_key", message: expect.any(String) },
    ]);
  });

  it("rejects bad slugs and URLs", () => {
    expect(bad((c) => (c.team.name = "1Acme"))[0]).toMatchObject({
      path: ["team", "name"],
      code: "schema.invalid_format",
    });

    expect(bad((c) => (c.people[0].handle = "x".repeat(31)))[0]).toMatchObject({
      path: ["people", 0, "handle"],
      code: "schema.too_big",
    });

    expect(bad((c) => (c.repos[0].url = "nonsense"))[0]).toMatchObject({
      path: ["repos", 0, "url"],
      code: "schema.invalid_format",
    });
  });

  it("requires at least one identity per human", () => {
    expect(bad((c) => (c.humans[0].identities = {}))[0]).toMatchObject({
      path: ["humans", 0, "identities"],
    });
  });

  it("rejects an invalid catalog version", () => {
    expect(bad((c) => (c.catalog.version = "^1.0.0"))).toEqual([
      {
        path: ["catalog", "version"],
        code: "catalog.invalid_version",
        message: expect.any(String),
      },
    ]);
  });

  it("rejects non-exact catalog versions", () => {
    for (const v of ["v1.0.0", ">=1.0.0", "1.x", "1.0", " 1.0.0"]) {
      expect(bad((c) => (c.catalog.version = v)).map((i) => i.code)).toEqual([
        "catalog.invalid_version",
      ]);
    }
  });

  it("accepts prerelease catalog versions", () => {
    const c = valid();
    c.catalog.version = "1.0.0-rc.1";
    expect(parseTeamConfig(c).ok).toBe(true);
  });

  it("requires at least one repo", () => {
    expect(bad((c) => (c.repos = []))[0]).toMatchObject({
      path: ["repos"],
      code: "schema.too_small",
    });
  });

  it("accepts repo checks and rejects empty or too many", () => {
    const ok = parseTeamConfig(
      (() => {
        const c: any = valid();
        c.repos[0].checks = ["pnpm lint"];
        return c;
      })(),
    );

    expect(ok.ok).toBe(true);
    expect(bad((c) => (c.repos[0].checks = [" "]))[0]).toMatchObject({
      path: ["repos", 0, "checks", 0],
    });

    expect(bad((c) => (c.repos[0].checks = []))[0]).toMatchObject({ path: ["repos", 0, "checks"] });
    expect(
      bad((c) => (c.repos[0].checks = Array.from({ length: 11 }, (_, i) => `c${i}`)))[0],
    ).toMatchObject({ path: ["repos", 0, "checks"] });
  });

  it("accepts repo conventions and instructions, and rejects paths outside the repository", () => {
    const ok = parseTeamConfig(
      (() => {
        const c: any = valid();
        c.repos[0].conventions = "Squash merge. Titles start with the ticket key.";
        c.repos[0].instructions = ["CLAUDE.md", "docs/agents.md"];
        return c;
      })(),
    );

    expect(ok.ok).toBe(true);
    expect(bad((c) => (c.repos[0].conventions = "  "))[0]).toMatchObject({
      path: ["repos", 0, "conventions"],
    });

    expect(bad((c) => (c.repos[0].instructions = ["../secrets.md"]))[0]).toMatchObject({
      path: ["repos", 0, "instructions", 0],
    });

    expect(bad((c) => (c.repos[0].instructions = ["/etc/passwd"]))[0]).toMatchObject({
      path: ["repos", 0, "instructions", 0],
    });

    expect(bad((c) => (c.repos[0].instructions = []))[0]).toMatchObject({
      path: ["repos", 0, "instructions"],
    });
  });

  it("rejects duplicate repo names", () => {
    expect(
      bad((c) => {
        c.repos[2].name = "app";
        c.people[3].repos = {};
      }),
    ).toEqual([
      { path: ["repos", 2, "name"], code: "repos.duplicate_name", message: expect.any(String) },
    ]);
  });

  it("allows at most one primary repo", () => {
    expect(bad((c) => (c.repos[2].kind = "primary"))).toEqual([
      { path: ["repos", 2, "kind"], code: "repos.multiple_primary", message: expect.any(String) },
    ]);
  });

  it("rejects duplicate handles", () => {
    expect(bad((c) => (c.people[3].handle = "ada"))).toEqual([
      {
        path: ["people", 3, "handle"],
        code: "people.duplicate_handle",
        message: expect.any(String),
      },
    ]);
  });

  it("rejects malformed grant keys and values", () => {
    expect(bad((c) => (c.people[0].repos = { "kind:other2": "read" }))).toEqual([
      {
        path: ["people", 0, "repos", "kind:other2"],
        code: "people.invalid_grant_key",
        message: expect.any(String),
      },
    ]);

    expect(bad((c) => (c.people[0].repos = { app: "admin" }))[0]).toMatchObject({
      path: ["people", 0, "repos", "app"],
      code: "schema.invalid_value",
    });
  });

  it("rejects grants to unknown repos", () => {
    expect(bad((c) => (c.people[1].repos = { nope: "read" }))).toEqual([
      {
        path: ["people", 1, "repos", "nope"],
        code: "people.unknown_repo",
        message: expect.any(String),
      },
    ]);
  });

  it("checks the shared usage groups", () => {
    const people = (c: any) => c.people.map((p: any) => p.handle);
    const ok = parseTeamConfig(
      (() => {
        const c: any = valid();
        c.policies = { usage: { shared: [people(c)] } };
        return c;
      })(),
    );

    expect(ok.ok).toBe(true);

    expect(bad((c) => (c.policies = { usage: { shared: [[people(c)[0], "ghost"]] } }))).toEqual([
      {
        path: ["policies", "usage", "shared", 0, 1],
        code: "policies.usage_shared_unknown_person",
        message: expect.any(String),
      },
    ]);

    expect(
      bad(
        (c) => (c.policies = { usage: { shared: [people(c), [people(c)[0], people(c)[1]]] } }),
      )[0],
    ).toMatchObject({ code: "policies.usage_shared_overlap" });

    expect(bad((c) => (c.policies = { usage: { shared: [[people(c)[0]]] } }))[0]).toMatchObject({
      code: "schema.too_small",
    });
  });

  it("requires the {handle} placeholder in the email pattern", () => {
    expect(bad((c) => (c.email.pattern = "team@acme.example"))).toEqual([
      {
        path: ["email", "pattern"],
        code: "email.missing_placeholder",
        message: expect.any(String),
      },
    ]);
  });

  it("bounds the stale-poll warning", () => {
    expect(bad((c) => (c.office.poll_warn_after_minutes = 0))[0]).toMatchObject({
      path: ["office", "poll_warn_after_minutes"],
      code: "schema.too_small",
    });
  });

  it("bounds the poll interval", () => {
    expect(bad((c) => (c.office.poll_interval_seconds = 5))[0]).toMatchObject({
      path: ["office", "poll_interval_seconds"],
      code: "schema.too_small",
    });
  });

  it("checks status names and loop guard bounds", () => {
    expect(bad((c) => (c.workflow.statuses = { wip: "x" }))[0]).toMatchObject({
      path: ["workflow", "statuses", "wip"],
    });

    expect(
      bad((c) => (c.policies.agent_loop_guard.max_runs_per_item_per_hour = 0))[0],
    ).toMatchObject({
      path: ["policies", "agent_loop_guard", "max_runs_per_item_per_hour"],
      code: "schema.too_small",
    });
  });

  it("requires defer threshold <= pause threshold", () => {
    expect(
      bad((c) => (c.policies.usage = { defer_scheduled_at: 0.99, pause_automatic_at: 0.9 })),
    ).toEqual([
      {
        path: ["policies", "usage", "defer_scheduled_at"],
        code: "policies.usage_threshold_order",
        message: expect.any(String),
      },
    ]);
  });

  it("checks the retry policy", () => {
    expect(
      bad((c) => (c.policies.retry = { base_minutes: 40, cap_minutes: 30, max_failures: 3 })),
    ).toEqual([
      {
        path: ["policies", "retry", "base_minutes"],
        code: "policies.retry_backoff_order",
        message: expect.any(String),
      },
    ]);

    expect(bad((c) => (c.policies.retry = { max_failures: 0 }))).toEqual([
      expect.objectContaining({ path: ["policies", "retry", "max_failures"] }),
    ]);
  });

  it("bounds message settings", () => {
    expect(bad((c) => (c.policies.messages.max_lines = 21))[0]).toMatchObject({
      path: ["policies", "messages", "max_lines"],
      code: "schema.too_big",
    });
  });
});

describe("adapter options", () => {
  afterEach(() => clearAdapterOptions());

  it("passes unknown adapters and validates registered ones", () => {
    const r = parseTeamConfig(valid());
    if (!r.ok) {
      throw new Error("invalid");
    }

    expect(validateAdapterOptions(r.config)).toEqual([]);

    registerAdapterOptions(
      "tracker",
      "linear",
      z.strictObject({ project: z.string(), team_id: z.string() }),
    );

    expect(validateAdapterOptions(r.config)).toEqual([
      {
        path: ["integrations", "tracker", "team_id"],
        code: "integrations.invalid_options",
        message: expect.any(String),
      },
    ]);
  });

  it("reports wrongly typed options at their path", () => {
    registerAdapterOptions("tracker", "linear", z.object({ project: z.number() }));
    const r = parseTeamConfig(valid());
    if (!r.ok) {
      throw new Error("invalid");
    }

    expect(validateAdapterOptions(r.config)[0]).toMatchObject({
      path: ["integrations", "tracker", "project"],
    });
  });
});

describe("JSON Schema", () => {
  it("committed team.schema.json is up to date (run `pnpm --filter @outstaff/core run schema`)", () => {
    const committed = readFileSync(
      new URL("../../schema/team.schema.json", import.meta.url),
      "utf8",
    );

    expect(committed).toBe(`${JSON.stringify(buildTeamJsonSchema(), null, 2)}\n`);
  });

  it("describes every property", () => {
    const missing: string[] = [];
    const walk = (node: any, path: string) => {
      if (!node || typeof node !== "object") {
        return;
      }

      for (const [k, v] of Object.entries<any>(node.properties ?? {})) {
        if (!v.description) {
          missing.push(`${path}.${k}`);
        }

        walk(v, `${path}.${k}`);
      }

      if (node.items) {
        walk(node.items, `${path}[]`);
      }
    };

    walk(buildTeamJsonSchema(), "$");
    expect(missing).toEqual([]);
  });
});
