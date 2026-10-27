import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseTeamConfig } from "#/config/parse.js";
import {
  buildPolicy,
  effectiveTools,
  evaluate,
  parseToolset,
  toolsToPacks,
  type Layout,
  type ToolCall,
} from "#/index.js";

const layout: Layout = {
  home: "/home/agent",
  workDir: "/work/main",
  reposDir: "/work/repos",
  worktreesDir: "/work/worktrees",
  scratchDir: "/work/scratch",
  memoryDir: "/work/memory",
  secretsDir: "/work/secrets",
};

const team = {
  repos: [
    { name: "app", url: "github.com/acme/app", kind: "primary" as const, default_branch: "main" },
  ],
};

const person = { repos: { app: "write" } as const };
const CWD = "/work/worktrees/app/feat";

const BASE = `version: 1
team: { name: acme }
catalog: { version: 1.0.0 }
repos:
  - { name: app, url: github.com/acme/app, kind: primary }
integrations:
  chat: { adapter: slack }
  vcs: { adapter: github }
  runtime: { adapter: claude }
`;

const parseTeam = (extra: string) => parseTeamConfig(parse(`${BASE}${extra}`));
const codes = (extra: string) => {
  const r = parseTeam(extra);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe("tools in team.yaml", () => {
  it("accepts team and person tools in every allow shape", () => {
    const r = parseTeam(`
people:
  - handle: sam
    name: Sam
    role: developer
    tools:
      kubectl: { version: 1.31.3, allow: [get, logs] }
tools:
  go: { version: 1.23.4, allow: all }
  their-cli:
    source: "ubi:vendor/their-cli"
    version: 0.9.1
    allow:
      - { subcommand: [status], reason: Read-only. }
`);

    expect(r.ok).toBe(true);
  });

  it.each(["latest", "1", "^1.2.3", ">=1.2", "1.x", "lts", ""])("rejects version %j", (v) => {
    expect(codes(`tools:\n  go: { version: "${v}", allow: all }\npeople: []`)).toContain(
      "tools.invalid_version",
    );
  });

  it("accepts exact versions with suffixes", () => {
    expect(codes(`tools:\n  go: { version: "1.23.4-rc.1", allow: all }\npeople: []`)).toEqual([]);
  });

  it("rejects duplicate verbs and duplicate sources", () => {
    expect(codes(`tools:\n  k: { version: 1.0.0, allow: [get, get] }\npeople: []`)).toContain(
      "tools.duplicate",
    );

    expect(
      codes(`tools:
  a: { version: 1.0.0, source: "ubi:x/y", allow: all }
  b: { version: 1.0.0, source: "ubi:x/y", allow: all }
people: []`),
    ).toContain("tools.duplicate");
  });

  describe("options", () => {
    const sum = "sha256:" + "ab".repeat(32);
    const tool = (opts: string, source = '"http:acmectl"') =>
      codes(
        `tools:\n  acmectl: { version: 36.0.0, source: ${source}, options: ${opts} }\npeople: []`,
      );

    it("accepts an http source with a checksum, or one per platform", () => {
      expect(
        tool(`{ url: "https://dl.acme.example/a-{{ version }}.zip", checksum: "${sum}" }`),
      ).toEqual([]);

      expect(
        tool(
          `{ platforms: { linux-x64: { url: "https://dl.acme.example/a.zip", checksum: "${sum}" } } }`,
        ),
      ).toEqual([]);
    });

    it("rejects options without a source", () => {
      expect(
        codes(`tools:\n  acmectl: { version: 36.0.0, options: { url: "x" } }\npeople: []`),
      ).toContain("tools.options_without_source");
    });

    it("rejects an http source without a checksum", () => {
      expect(tool('{ url: "https://dl.acme.example/a.zip" }')).toContain("tools.http_checksum");
      expect(
        codes(`tools:\n  acmectl: { version: 36.0.0, source: "http:acmectl" }\npeople: []`),
      ).toContain("tools.http_checksum");
    });

    it("rejects a platform without a checksum", () => {
      expect(
        tool(
          `{ platforms: { linux-x64: { url: "u", checksum: "${sum}" }, linux-arm64: { url: "v" } } }`,
        ),
      ).toContain("tools.http_checksum");
    });

    it("rejects a version option and does not require a checksum for other backends", () => {
      expect(tool(`{ version: "1.0.0", checksum: "${sum}" }`)).toContain("tools.reserved_option");
      expect(tool('{ bin_path: "bin" }', '"github:acme/acmectl"')).toEqual([]);
    });

    it("rejects values that are not strings", () => {
      expect(tool("{ url: 5 }")).toContain("schema.invalid");
    });

    it("keeps the options on the effective tool", () => {
      const r = parseTeam(
        `tools:\n  acmectl: { version: 36.0.0, source: "http:acmectl", options: { checksum: "${sum}" } }\npeople: []`,
      );

      expect(r.ok && effectiveTools({ team: r.config.tools })[0]?.options).toEqual({
        checksum: sum,
      });
    });
  });

  it("rejects a structured rule for another program and unknown keys", () => {
    expect(
      codes(`tools:
  a: { version: 1.0.0, allow: [{ program: b, reason: r }] }
people: []`),
    ).toContain("tools.rule_program");

    expect(codes(`tools:\n  a: { version: 1.0.0, allow: all, extra: 1 }\npeople: []`)).toContain(
      "schema.unknown_key",
    );
  });
});

const toolset = (text: string) => parseToolset(text, "test");

describe("effective tools", () => {
  const stock = toolset(`name: infra
tools:
  kubectl: { version: 1.30.0, allow: [get] }
  helm: { version: 3.16.3, allow: [template] }
`);

  it("lets person beat team beat toolset, replacing the whole declaration", () => {
    const tools = effectiveTools({
      toolsets: [stock],
      team: { kubectl: { version: "1.31.0", allow: ["get", "logs"] } },
      person: {
        kubectl: { version: "1.32.0", allow: ["get"] },
        go: { version: "1.23.4", allow: "all" },
      },
    });

    expect(tools.map((t) => [t.name, t.version, t.origin])).toEqual([
      ["go", "1.23.4", "person"],
      ["helm", "3.16.3", "toolset"],
      ["kubectl", "1.32.0", "person"],
    ]);
  });

  it("lets a later toolset replace an earlier one", () => {
    const later = toolset("name: later\ntools:\n  helm: { version: 3.17.0, allow: all }\n");
    expect(
      effectiveTools({ toolsets: [stock, later] }).find((t) => t.name === "helm")?.version,
    ).toBe("3.17.0");
  });
});

describe("policy from tools", () => {
  const run = (
    tools: Parameters<typeof effectiveTools>[0],
    command: string,
    profile: "code" | "infra" = "code",
  ) => {
    const packs = toolsToPacks(effectiveTools(tools));
    const call: ToolCall = { kind: "shell", command, cwd: CWD };
    return evaluate(buildPolicy({ profile, person, team, layout, packs }), call);
  };

  it("runs anything without a declaration, and anything of a tool declared without allow", () => {
    expect(run({}, "go build ./...").effect).toBe("allow");
    expect(run({ person: { go: { version: "1.23.4" } } }, "go build")).toMatchObject({
      effect: "allow",
      rule: "tools.go.all",
    });
  });

  it("lifts the infrastructure defaults for a tool declared without allow", () => {
    expect(run({}, "kubectl apply -f x").effect).toBe("deny");
    expect(run({ team: { kubectl: { version: "1.31.3" } } }, "kubectl apply -f x").effect).toBe(
      "allow",
    );
  });

  it("all allows any arguments", () => {
    const t = { team: { go: { version: "1.23.4", allow: "all" as const } } };
    expect(run(t, "go test ./...").effect).toBe("allow");
    expect(run(t, "go run main.go").effect).toBe("allow");
    expect(run(t, "go build && go vet").effect).toBe("allow");
  });

  it("a verb list allows those first subcommands only", () => {
    const t = { team: { kubectl: { version: "1.31.3", allow: ["get", "describe"] } } };
    expect(run(t, "kubectl get pods -n web").effect).toBe("allow");
    expect(run(t, "kubectl delete pod x").rule).toBe("commands.narrowed");
    expect(run(t, "kubectl logs x").rule).toBe("commands.narrowed");
    expect(run(t, "kubectl").rule).toBe("commands.narrowed");
  });

  it("structured rules apply as given", () => {
    const t = {
      person: {
        "their-cli": {
          version: "0.9.1",
          allow: [
            {
              subcommand: ["deploy"],
              reason: "Dry runs only.",
              args: [{ kind: "flag" as const, names: ["--dry-run"], present: true }],
            },
          ],
        },
      },
    };

    expect(run(t, "their-cli deploy --dry-run").effect).toBe("allow");
    expect(run(t, "their-cli deploy").effect).toBe("deny");
  });

  it("built-in denies still win", () => {
    const t = {
      team: {
        sudo: { version: "1.9.0", allow: "all" as const },
      },
    };

    expect(run(t, "sudo ls").effect).toBe("deny");
  });

  it("an overridden toolset declaration no longer allows its verbs", () => {
    const stock = toolset(
      "name: infra\nprofiles: [infra]\ntools:\n  kubectl: { version: 1.30.0, allow: [get, logs] }\n",
    );

    const t = { toolsets: [stock], person: { kubectl: { version: "1.31.0", allow: ["get"] } } };
    expect(run(t, "kubectl get pods").effect).toBe("allow");
    expect(run(t, "kubectl logs x").effect).toBe("deny");
  });

  it("toolset tools respect the toolset's profiles", () => {
    const stock = toolset(
      "name: infra\nprofiles: [infra]\ntools:\n  kubectl: { version: 1.30.0, allow: [get] }\n",
    );

    expect(run({ toolsets: [stock] }, "kubectl get pods", "infra").effect).toBe("allow");
    expect(run({ toolsets: [stock] }, "kubectl apply -f x", "infra").effect).toBe("deny");
    expect(run({ toolsets: [stock] }, "kubectl logs x", "code").rule).toBe("commands.default");
  });

  it("marks packs with their source", () => {
    const stock = toolset("name: infra\ntools:\n  helm: { version: 3.16.3, allow: all }\n");
    const packs = toolsToPacks(
      effectiveTools({ toolsets: [stock], team: { go: { version: "1.23.4", allow: "all" } } }),
    );

    expect(packs.map((p) => [p.id, p.source]).toSorted()).toEqual([
      ["team.tools", "team"],
      ["toolset.infra.tools", "toolset"],
    ]);
  });
});

describe("toolsets", () => {
  it("needs at least one rule or tool", () => {
    expect(() => toolset("name: empty\n")).toThrow(/at least one rule or tool/);
  });
});
