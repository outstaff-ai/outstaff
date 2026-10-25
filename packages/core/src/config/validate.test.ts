import { describe, expect, it } from "vitest";
import {
  CONFIG_CODES,
  documentedCodes,
  parseTeamConfig,
  validateTeam,
  WARNING_CODES,
} from "../index.js";
import type {
  AdapterInfo,
  Capability,
  RoleNeeds,
  TeamConfigInput,
  ValidationContext,
} from "../index.js";

const adapter = (
  port: AdapterInfo["port"],
  name: string,
  capabilities: Capability[],
): [string, AdapterInfo] => [`${port}/${name}`, { port, name, capabilities }];

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  roles: new Map<string, RoleNeeds>([
    ["developer", { needs: ["vcs.pullRequests"] }],
    ["architect", { needs: ["knowledge.docs"], optionalNeeds: ["tracker.issues"] }],
    ["a11y", { needs: [] }],
    ["reviewer", { needs: [] }],
  ]),
  adapters: new Map([
    adapter("vcs", "github", ["vcs.pullRequests", "vcs.reviewThreads", "vcs.reactions"]),
    adapter("chat", "slack", ["chat.messages", "chat.agentProfile"]),
    adapter("runtime", "claude-agent-sdk", ["runtime.sessions"]),
    adapter("knowledge", "notion", ["knowledge.docs"]),
    adapter("tracker", "linear", ["tracker.issues"]),
  ]),
  ...over,
});

const config = (mutate: (c: any) => void = () => {}) => {
  const c: any = {
    version: 1,
    team: { name: "acme" },
    humans: [{ name: "Alex", identities: { vcs: "alex" } }],
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
    people: [
      {
        handle: "ada",
        name: "Ada",
        role: "developer",
        identities: { vcs: "acme-ada[bot]", chat: "U0ADA", tracker: "ada" },
        repos: { app: "write" },
      },
      {
        handle: "marcus",
        name: "Marcus",
        role: "architect",
        identities: { vcs: "acme-marcus[bot]", chat: "U0MARCUS", tracker: "marcus" },
        repos: { app: "read" },
      },
    ],
    integrations: {
      chat: { adapter: "slack" },
      vcs: { adapter: "github" },
      runtime: { adapter: "claude-agent-sdk" },
      knowledge: { adapter: "notion" },
      tracker: { adapter: "linear" },
    },
  };

  mutate(c);
  const r = parseTeamConfig(c as TeamConfigInput);
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
};

describe("validateTeam", () => {
  it("is clean for a fully supported team", () => {
    expect(validateTeam(config(), ctx())).toEqual({ errors: [], warnings: [] });
  });

  it("errors on unknown roles only when the catalog is known", () => {
    const c = config((x) => (x.people[0].role = "wizard"));
    expect(validateTeam(c, ctx()).errors).toEqual([
      {
        path: ["people", 0, "role"],
        code: "people.unknown_role",
        message: 'Role "wizard" is not in the catalog.',
      },
    ]);

    expect(validateTeam(c, ctx({ roles: new Map() })).errors).toEqual([]);
  });

  it("errors on unknown extends entries", () => {
    const c = config((x) => (x.people[0].extends = ["a11y", "nope"]));
    expect(validateTeam(c, ctx()).errors).toEqual([
      {
        path: ["people", 0, "extends", 1],
        code: "people.unknown_extends",
        message: '"nope" is not a role in the catalog.',
      },
    ]);

    expect(validateTeam(c, ctx({ roles: new Map() })).errors).toEqual([]);
  });

  it("errors on write grants without pull request support", () => {
    const c = config(
      (x) => (x.people[0].repos = { app: "write", "kind:primary": "read", "*": "write" }),
    );

    const noPr = ctx({
      adapters: new Map([
        adapter("vcs", "github", []),
        adapter("chat", "slack", []),
        adapter("runtime", "claude-agent-sdk", []),
        adapter("knowledge", "notion", ["knowledge.docs"]),
        adapter("tracker", "linear", []),
      ]),
    });

    expect(validateTeam(c, noPr).errors).toEqual([
      {
        path: ["people", 0, "repos", "app"],
        code: "people.write_without_vcs",
        message: 'Grant "app: write" needs a vcs integration that provides vcs.pullRequests.',
      },
      {
        path: ["people", 0, "repos", "*"],
        code: "people.write_without_vcs",
        message: 'Grant "*: write" needs a vcs integration that provides vcs.pullRequests.',
      },
    ]);
  });

  it("errors on unknown adapters only when adapters are known", () => {
    const c = config((x) => (x.integrations.knowledge.adapter = "confluence"));
    const report = validateTeam(c, ctx());
    expect(report.errors).toEqual([
      {
        path: ["integrations", "knowledge", "adapter"],
        code: "integrations.unknown_adapter",
        message: 'No knowledge adapter named "confluence" is installed.',
      },
    ]);

    // An unknown adapter provides nothing, so the dependent need is also reported.
    expect(report.warnings.map((w) => w.code)).toEqual(["capability.missing"]);
    expect(validateTeam(c, ctx({ adapters: new Map() })).errors).toEqual([]);
  });

  it("warns when a needed capability is missing", () => {
    const c = config((x) => delete x.integrations.knowledge);
    expect(validateTeam(c, ctx()).warnings).toEqual([
      {
        path: ["people", 1, "role"],
        code: "capability.missing",
        message: 'Role "architect" needs knowledge.docs, which no configured integration provides.',
        consequence:
          "architect marcus cannot write design docs: no knowledge integration provides knowledge.docs.",
      },
    ]);
  });

  it("warns when a policies switch needs a capability the vcs adapter lacks, unless it is off", () => {
    const noReactions = ctx({
      adapters: new Map([
        adapter("vcs", "github", ["vcs.pullRequests", "vcs.reviewThreads"]),
        adapter("chat", "slack", ["chat.messages", "chat.agentProfile"]),
        adapter("runtime", "claude-agent-sdk", ["runtime.sessions"]),
        adapter("knowledge", "notion", ["knowledge.docs"]),
        adapter("tracker", "linear", ["tracker.issues"]),
      ]),
    });

    expect(validateTeam(config(), noReactions).warnings).toEqual([
      {
        path: ["policies", "acknowledge", "vcs"],
        code: "policies.capability_missing",
        message:
          'policies.acknowledge.vcs is true, but the vcs adapter "github" does not provide vcs.reactions.',
        consequence:
          "policies.acknowledge.vcs does nothing: the vcs adapter cannot react to pull request comments; set it to false to silence this.",
      },
    ]);

    const off = config((x) => (x.policies = { acknowledge: { vcs: false } }));
    expect(validateTeam(off, noReactions).warnings).toEqual([]);
    expect(validateTeam(config(), ctx()).warnings).toEqual([]);
  });

  it("warns when the chat profile is on and the chat adapter cannot show it, unless it is off", () => {
    const plain = ctx({
      adapters: new Map([
        adapter("vcs", "github", ["vcs.pullRequests", "vcs.reviewThreads", "vcs.reactions"]),
        adapter("chat", "slack", ["chat.messages"]),
        adapter("runtime", "claude-agent-sdk", ["runtime.sessions"]),
        adapter("knowledge", "notion", ["knowledge.docs"]),
        adapter("tracker", "linear", ["tracker.issues"]),
      ]),
    });

    expect(validateTeam(config(), plain).warnings).toEqual([
      expect.objectContaining({
        path: ["policies", "chat", "profile"],
        code: "policies.capability_missing",
      }),
    ]);

    const off = config((x) => (x.policies = { chat: { profile: false } }));
    expect(validateTeam(off, plain).warnings).toEqual([]);
  });

  it("warns about missing optional capabilities", () => {
    const c = config((x) => delete x.integrations.tracker);
    expect(validateTeam(c, ctx()).warnings).toEqual([
      {
        path: ["people", 1, "role"],
        code: "capability.optional_missing",
        message:
          'Role "architect" can use tracker.issues, which no configured integration provides.',
        consequence:
          "architect marcus cannot read or update tickets: no tracker integration provides tracker.issues.",
      },
    ]);
  });

  it("counts needs of extended roles against the person", () => {
    const c = config((x) => {
      delete x.integrations.knowledge;
      x.people[0].extends = ["architect"];
    });

    expect(validateTeam(c, ctx()).warnings.map((w) => [w.path, w.code, w.consequence])).toEqual([
      [
        ["people", 0, "role"],
        "capability.missing",
        "architect ada cannot write design docs: no knowledge integration provides knowledge.docs.",
      ],
      [
        ["people", 1, "role"],
        "capability.missing",
        "architect marcus cannot write design docs: no knowledge integration provides knowledge.docs.",
      ],
    ]);
  });

  it("warns when humans is omitted", () => {
    const c = config((x) => delete x.humans);
    expect(validateTeam(c, ctx()).warnings).toEqual([
      {
        path: ["humans"],
        code: "trust.default",
        message: "humans is not set, so trust follows the default rule.",
        consequence:
          "trusted humans are repo writers and full chat-workspace members; set humans: for open-source repos or large workspaces",
      },
    ]);
  });

  it("warns about writers without a vcs identity", () => {
    const c = config((x) => delete x.people[0].identities.vcs);
    expect(validateTeam(c, ctx()).warnings).toEqual([
      {
        path: ["people", 0, "identities", "vcs"],
        code: "people.missing_vcs_identity",
        message: "ada has a write grant but no identities.vcs.",
        consequence:
          "the office won't recognise ada's pull requests and comments as the agent's own; run `ost setup ada --derive` and copy the value into team.yaml.",
      },
    ]);
  });

  it("does not warn a reader without a vcs identity, but warns a reviewer", () => {
    const c = config((x) => delete x.people[1].identities.vcs);
    expect(validateTeam(c, ctx()).warnings).toEqual([]);

    c.people[1]!.role = "reviewer";
    expect(validateTeam(c, ctx()).warnings.map((w) => w.code)).toEqual([
      "people.reviewer_without_github",
    ]);
  });

  it("does not warn about vcs for a person without GitHub access", () => {
    const c = config((x) => {
      x.people[1].repos = {};
      delete x.people[1].identities.vcs;
    });

    expect(validateTeam(c, ctx()).warnings).toEqual([]);
  });

  it("warns per person and port about a missing chat or tracker identity", () => {
    const c = config((x) => {
      delete x.people[0].identities.chat;
      delete x.people[1].identities.tracker;
    });

    expect(validateTeam(c, ctx()).warnings).toEqual([
      {
        path: ["people", 0, "identities", "chat"],
        code: "people.missing_chat_identity",
        message: "ada has no identities.chat.",
        consequence:
          "the office won't recognise ada's chat messages; run `ost setup ada --derive` and copy the value into team.yaml.",
      },
      {
        path: ["people", 1, "identities", "tracker"],
        code: "people.missing_tracker_identity",
        message: "marcus has no identities.tracker.",
        consequence:
          "the office won't recognise marcus's tracker activity; run `ost setup marcus --derive` and copy the value into team.yaml.",
      },
    ]);
  });

  it("does not ask for a tracker identity when no tracker is configured", () => {
    const c = config((x) => {
      delete x.integrations.tracker;
      x.people.forEach((p: any) => delete p.identities.tracker);
    });

    expect(
      validateTeam(c, ctx()).warnings.filter((w) => w.code.startsWith("people.missing")),
    ).toEqual([]);
  });

  it("accepts a person without grants whose role does not review", () => {
    const c = config((x) => (x.people[1].repos = {}));
    expect(validateTeam(c, ctx()).warnings).toEqual([]);
  });

  it("warns about a reviewer without grants", () => {
    const c = config((x) => {
      x.people[1].role = "reviewer";
      x.people[1].repos = {};
    });

    expect(validateTeam(c, ctx()).warnings).toEqual([
      {
        path: ["people", 1, "repos"],
        code: "people.reviewer_without_github",
        message: "marcus is a reviewer but has no repo grants.",
        consequence:
          "marcus cannot review pull requests as themselves; give them a read or write grant and their own GitHub App.",
      },
    ]);
  });

  it("warns about a reviewer without an own App", () => {
    const c = config((x) => {
      x.people[1].role = "reviewer";
      delete x.people[1].identities.vcs;
    });

    expect(validateTeam(c, ctx()).warnings).toEqual([
      {
        path: ["people", 1, "identities", "vcs"],
        code: "people.reviewer_without_github",
        message: "marcus is a reviewer but has no identities.vcs (no GitHub App of their own).",
        consequence:
          "marcus cannot review pull requests as themselves; give them a read or write grant and their own GitHub App.",
      },
    ]);
  });

  it("does not warn about a reviewer with a grant and an own App", () => {
    const c = config((x) => {
      x.people[1].role = "reviewer";
      x.people[1].identities.vcs = "acme-marcus[bot]";
    });

    expect(validateTeam(c, ctx()).warnings).toEqual([]);
  });
});

describe("documentedCodes", () => {
  it("documents every error and warning code", () => {
    const all = [...Object.values(CONFIG_CODES), ...Object.values(WARNING_CODES)].toSorted();
    expect(Object.keys(documentedCodes).toSorted()).toEqual(all);
    for (const text of Object.values(documentedCodes)) {
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("runs the identity check of each configured adapter and no other", () => {
    const seen: string[] = [];
    const identityValidators = new Map([
      [
        "chat/slack",
        () => {
          seen.push("slack");
          return [
            {
              path: ["humans", 0, "identities", "chat"],
              code: WARNING_CODES.identityChatNotMemberId,
              message: "m",
              consequence: "c",
            },
          ];
        },
      ],
      ["vcs/other", () => (seen.push("other"), [])],
    ]);

    const report = validateTeam(config(), ctx({ adapters: new Map(), identityValidators }));
    expect(seen).toEqual(["slack"]);
    expect(report.warnings.map((w) => [w.path, w.code])).toContainEqual([
      ["humans", 0, "identities", "chat"],
      "identities.chat_not_member_id",
    ]);
  });
});
