import { describe, expect, it } from "vitest";
import {
  buildPolicy,
  evaluate,
  loadToolset,
  parseToolset,
  teamCommandsToPack,
  toolsetToPack,
  type Layout,
  type Profile,
  type RulePack,
  type ToolCall,
} from "../index.js";
import { parse } from "yaml";
import { parseTeamConfig } from "../config/parse.js";

const layout: Layout = {
  home: "/home/agent",
  workDir: "/work",
  reposDir: "/work/repos",
  worktreesDir: "/work/worktrees",
  scratchDir: "/work/scratch",
  memoryDir: "/work/memory",
  secretsDir: "/work/secrets",
};

const repo = (name: string, kind: "primary" | "other") => ({
  name,
  url: `github.com/acme/${name}`,
  kind,
  default_branch: "main",
});

const team = { repos: [repo("app", "primary"), repo("site", "other")] };
const person = { repos: { app: "write", site: "read" } as const };
const APP = "/work/worktrees/app/feat";
const SITE = "/work/worktrees/site/x";

const run = (profile: Profile, packs: RulePack[], command: string, cwd = APP) => {
  const call: ToolCall = { kind: "shell", command, cwd };
  return evaluate(buildPolicy({ profile, person, team, layout, packs }), call);
};

const BASE = `version: 1
team: { name: acme }
catalog: { version: 1.0.0 }
repos:
  - { name: app, url: github.com/acme/app, kind: primary }
people: []
integrations:
  chat: { adapter: slack }
  vcs: { adapter: github }
  runtime: { adapter: claude }
`;

const parseText = (text: string) => parseTeamConfig(parse(text));

const catalogFile = (name: string) =>
  new URL(`../../../catalog/toolsets/${name}.yaml`, import.meta.url).pathname;

const code = toolsetToPack(loadToolset(catalogFile("code")));
const infra = toolsetToPack(loadToolset(catalogFile("infra")));

describe("catalog toolsets", () => {
  it("code allows pnpm test in a code-profile write repo", () => {
    expect(run("code", [code], "pnpm test").effect).toBe("allow");
    expect(run("code", [code], "pnpm run build && node dist/a.js").effect).toBe("allow");
    expect(run("code", [code], "npx vitest run").effect).toBe("allow");
  });

  it("code does not cover publishing, and docs and readonly get no toolchains", () => {
    expect(run("code", [code], "pnpm publish").effect).toBe("ask");
    expect(run("docs", [code], "pnpm test").effect).toBe("ask");
    expect(run("readonly", [code], "pnpm test").effect).toBe("ask");
    expect(run("code", [], "pnpm test").effect).toBe("ask");
  });

  it("infra allows read-only verbs for the infra profile only", () => {
    expect(run("infra", [infra], "terraform plan").effect).toBe("allow");
    expect(run("infra", [infra], "kubectl get pods").effect).toBe("allow");
    expect(run("infra", [infra], "helm template .").effect).toBe("allow");
    expect(run("infra", [infra], "terraform apply").effect).toBe("ask");
    expect(run("code", [infra], "terraform plan").effect).toBe("ask");
  });

  it("names the toolset in the rule id", () => {
    expect(run("code", [code], "pnpm test").rule).toBe("code.allow.pnpm.test");
  });
});

describe("rule packs", () => {
  const forge = (source: RulePack["source"]): RulePack => ({
    id: "forge",
    source,
    rules: [
      {
        id: "forge.view",
        program: "forge",
        subcommand: ["pr", "view"],
        effect: "allow",
        reason: "r",
      },
      {
        id: "forge.create",
        program: "forge",
        subcommand: ["pr", "create"],
        effect: "allow",
        requiresRepo: "write",
        reason: "w",
      },
      {
        id: "forge.api.method",
        program: "forge",
        subcommand: ["api"],
        args: [{ kind: "flag-value", names: ["-X", "--method"], values: ["GET"], match: "not-in" }],
        effect: "deny",
        reason: "mutates",
      },
      { id: "forge.api", program: "forge", subcommand: ["api"], effect: "allow", reason: "get" },
    ],
  });

  it("merges rules after the built-in ones", () => {
    const p = buildPolicy({ profile: "code", person, team, layout, packs: [forge("adapter")] });
    expect(p.commands.at(-1)?.id).toBe("forge.api");
    expect(p.commands.some((r) => r.id === "network.curl")).toBe(true);
  });

  it("honours requiresRepo for pack rules", () => {
    const packs = [forge("adapter")];
    expect(run("code", packs, "forge pr create").effect).toBe("allow");
    expect(run("code", packs, "forge pr create", SITE)).toMatchObject({
      effect: "deny",
      rule: "git.read-only-repo",
    });
  });

  it("treats a write grant as satisfying requiresRepo read", () => {
    const pack: RulePack = {
      id: "r",
      source: "adapter",
      rules: [
        { id: "r.view", program: "forge", requiresRepo: "read", effect: "allow", reason: "r" },
      ],
    };

    expect(run("code", [pack], "forge x").effect).toBe("allow");
    expect(run("code", [pack], "forge x", SITE).effect).toBe("allow");
    expect(run("code", [pack], "forge x", "/work/scratch").rule).toBe("git.no-repo");
  });

  it("applies pack profiles", () => {
    const pack: RulePack = { ...forge("adapter"), profiles: ["infra"] };
    expect(run("infra", [pack], "forge pr view 1").effect).toBe("allow");
    expect(run("code", [pack], "forge pr view 1").effect).toBe("ask");
  });

  it.each(["adapter", "toolset", "team"] as const)("deny wins in a %s pack", (source) => {
    const packs = [forge(source)];
    expect(run("code", packs, "forge api repos/x").effect).toBe("allow");
    expect(run("code", packs, "forge api -X POST repos/x")).toMatchObject({
      effect: "deny",
      rule: "forge.api.method",
    });
  });

  it("a deny from one source beats an allow from another, in either order", () => {
    const deny: RulePack = {
      id: "d",
      source: "team",
      rules: [
        { id: "d.pnpm", program: "pnpm", subcommand: ["test"], effect: "deny", reason: "no" },
      ],
    };

    for (const packs of [
      [code, deny],
      [deny, code],
    ]) {
      expect(run("code", packs, "pnpm test")).toMatchObject({ effect: "deny", rule: "d.pnpm" });
    }
  });

  it("packs cannot allow what core denies", () => {
    const pack: RulePack = {
      id: "p",
      source: "team",
      rules: [
        { id: "p.curl", program: "curl", effect: "allow", reason: "x" },
        { id: "p.bash", program: "bash", effect: "allow", reason: "x" },
      ],
    };

    expect(run("code", [pack], "curl x").rule).toBe("network.curl");
    expect(run("code", [pack], "bash -c ls").rule).toBe("wrapper.bash");
  });
});

describe("team commands", () => {
  const pack = teamCommandsToPack({
    allow: [
      { program: "make", subcommand: ["deploy-preview"], reason: "Preview deploys are safe." },
      { program: "acme-cli", reason: "Our own tool." },
    ],
    deny: [{ program: "acme-cli", subcommand: ["prod"], reason: "Never touch prod." }],
  });

  it("allows a custom command", () => {
    expect(run("code", [pack!], "make deploy-preview")).toMatchObject({
      effect: "allow",
      rule: "team.allow.make.deploy-preview",
    });

    expect(run("code", [pack!], "make deploy").effect).toBe("ask");
  });

  it("deny entries beat allow entries", () => {
    expect(run("code", [pack!], "acme-cli status").effect).toBe("allow");
    expect(run("code", [pack!], "acme-cli prod push")).toMatchObject({
      effect: "deny",
      rule: "team.deny.acme-cli.prod",
    });
  });

  it("is undefined without entries", () => {
    expect(teamCommandsToPack(undefined)).toBeUndefined();
    expect(teamCommandsToPack({})).toBeUndefined();
  });
});

describe("toolset files", () => {
  it("rejects unknown keys with the file name", () => {
    expect(() => parseToolset("name: x\nrules: []\n", "x.yaml")).toThrow(/Invalid toolset x.yaml/);
    expect(() =>
      parseToolset("name: x\nrules:\n  - program: a\n    reason: r\n    typo: 1\n"),
    ).toThrow(/typo/);
  });

  it("expands program lists and verbs", () => {
    const pack = toolsetToPack(
      parseToolset("name: t\nrules:\n  - program: [a, b]\n    verbs: [x, y]\n    reason: r\n"),
    );

    expect(pack.rules.map((r) => r.id)).toEqual([
      "t.allow.a.x",
      "t.allow.a.y",
      "t.allow.b.x",
      "t.allow.b.y",
    ]);
  });

  it("rejects verbs together with subcommand", () => {
    expect(() =>
      parseToolset(
        "name: t\nrules:\n  - program: a\n    verbs: [x]\n    subcommand: [y]\n    reason: r\n",
      ),
    ).toThrow(/either verbs or subcommand/);
  });
});

describe("policies.commands in team.yaml", () => {
  it("parses into a team pack", () => {
    const r = parseText(
      `${BASE}policies:\n  commands:\n    allow:\n      - program: make\n        subcommand: [lint]\n        reason: Lint.\n`,
    );

    const config = r.ok ? r.config : undefined;
    expect(teamCommandsToPack(config?.policies?.commands)?.rules).toHaveLength(1);
  });

  it("requires a reason and refuses git", () => {
    const r = parseText(
      `${BASE}policies:\n  commands:\n    deny:\n      - program: make\n      - program: git\n        reason: x\n`,
    );

    const issues = r.ok ? [] : r.issues;
    expect(issues.map((i) => i.code)).toContain("policies.command_program");
    expect(issues.map((i) => i.path.join("."))).toContain("policies.commands.deny.0.reason");
  });
});
