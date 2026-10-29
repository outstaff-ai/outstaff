import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseTeamConfig } from "#/config/parse.js";
import {
  buildPolicy,
  effectiveTools,
  evaluate,
  toolsToPacks,
  type Layout,
  type Tools,
} from "#/index.js";
import { leadingValues, operands } from "#/permissions/operands.js";

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

const BASE = `version: 1
team: { name: acme }
catalog: { version: 1.0.0 }
repos:
  - { name: app, url: github.com/acme/app, kind: primary }
integrations:
  chat: { adapter: slack }
  vcs: { adapter: github }
  runtime: { adapter: claude }
people: []
`;

const parseTeam = (tools: string) => parseTeamConfig(parse(`${BASE}tools:\n${tools}`));

const toolsOf = (tools: string): Tools => {
  const r = parseTeam(tools);
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config.tools!;
};

const issues = (tools: string) => {
  const r = parseTeam(tools);
  return r.ok ? [] : r.issues.map((i) => [i.code, i.path.join(".")]);
};

const run = (tools: Tools, command: string) => {
  const packs = toolsToPacks(effectiveTools({ team: tools }));
  const policy = buildPolicy({ profile: "code", person: { repos: {} }, team, layout, packs });
  return evaluate(policy, { kind: "shell", command, cwd: "/work/main" });
};

describe("deny in a tool declaration", () => {
  const acmectl = toolsOf(`  acmectl: { version: 2.4.0, allow: all, deny: [delete, "wipe"] }\n`);

  it("refuses a denied subcommand after a global option, naming the deny rule", () => {
    expect(run(acmectl, "acmectl -c prod delete x")).toEqual({
      effect: "deny",
      reason: "acmectl delete is denied by the acmectl tools declaration.",
      rule: "tools.acmectl.deny.delete",
    });
  });

  it("runs what is not denied", () => {
    expect(run(acmectl, "acmectl -c prod status")).toMatchObject({
      effect: "allow",
      rule: "tools.acmectl.all",
    });
  });

  it.each([
    "acmectl wipe",
    "acmectl --context=prod wipe",
    "acmectl -c prod -v x delete y",
    "acmectl -v delete",
    "cd /tmp && acmectl -c prod delete x",
  ])("refuses %s", (command) => {
    expect(run(acmectl, command).effect).toBe("deny");
  });

  it.each(["acmectl status delete", "acmectl get -- delete", "acmectl -c prod -- status"])(
    "lets %s run: delete is not the subcommand",
    (command) => {
      expect(run(acmectl, command).effect).toBe("allow");
    },
  );

  it("wins over a verb list that allows the same verb", () => {
    const t = toolsOf(`  acmectl: { version: 2.4.0, allow: [status, delete], deny: [delete] }\n`);
    expect(run(t, "acmectl status").effect).toBe("allow");
    expect(run(t, "acmectl delete x").rule).toBe("tools.acmectl.deny.delete");
  });

  it("takes structured rules, with their reason", () => {
    const t = toolsOf(`  acmectl:
    version: 2.4.0
    deny:
      - subcommand: [reboot]
        args: [{ kind: positional, index: 0, pattern: "^(recovery|bootloader)$" }]
        reason: Leaves the device in a mode only a human can undo.
      - { args: [{ kind: flag, names: [-w], present: true }], reason: Wipes the device. }
`);

    expect(run(t, "acmectl -s panel-1 reboot recovery")).toEqual({
      effect: "deny",
      reason: "Leaves the device in a mode only a human can undo.",
      rule: "tools.acmectl.deny.0",
    });

    expect(run(t, "acmectl reboot").effect).toBe("allow");
    expect(run(t, "acmectl -w").rule).toBe("tools.acmectl.deny.1");
  });
});

describe("valued_options", () => {
  const t = toolsOf(`  acmectl:
    version: 2.4.0
    valued_options: [-c, --context]
    allow: [status, logs]
    deny: [delete]
`);

  it("lets an allow list find the subcommand after a declared option", () => {
    expect(run(t, "acmectl -c prod status").effect).toBe("allow");
    expect(run(t, "acmectl --context prod logs web").effect).toBe("allow");
    expect(run(t, "acmectl -c prod delete x").rule).toBe("tools.acmectl.deny.delete");
    expect(run(t, "acmectl -c status delete").rule).toBe("tools.acmectl.deny.delete");
  });

  it("makes deny rules exact: an undeclared option takes no value", () => {
    expect(run(t, "acmectl -v status delete").effect).toBe("allow");
  });

  it("does not let an allow list guess at undeclared options", () => {
    const narrow = toolsOf(`  acmectl: { version: 2.4.0, allow: [status] }\n`);
    expect(run(narrow, "acmectl -c prod status").rule).toBe("commands.narrowed");
    expect(run(narrow, "acmectl --context=prod status").effect).toBe("allow");
  });
});

describe("validating deny and valued_options", () => {
  it("rejects a verb denied twice and a deny rule for another program", () => {
    expect(issues(`  acmectl: { version: 2.4.0, deny: [delete, delete] }\n`)).toEqual([
      ["tools.duplicate", "tools.acmectl.deny.1"],
    ]);

    expect(
      issues(`  acmectl: { version: 2.4.0, deny: [{ program: other, reason: r }] }\n`),
    ).toEqual([["tools.rule_program", "tools.acmectl.deny.0.program"]]);
  });

  it("rejects an empty deny list and a valued option that is not an option", () => {
    expect(issues(`  acmectl: { version: 2.4.0, deny: [] }\n`)).not.toEqual([]);
    expect(issues(`  acmectl: { version: 2.4.0, valued_options: [context] }\n`)).not.toEqual([]);
    expect(issues(`  acmectl: { version: 2.4.0, valued_options: ["--a=b"] }\n`)).not.toEqual([]);
  });

  it("accepts a rule that names its own program", () => {
    expect(
      issues(`  acmectl: { version: 2.4.0, deny: [{ program: acmectl, reason: r }] }\n`),
    ).toEqual([]);
  });
});

describe("operands", () => {
  it("leaves out the values of valued options, and takes every word after --", () => {
    expect(operands(["-c", "prod", "get", "-o", "json", "x"], ["-c"])).toEqual([
      "get",
      "json",
      "x",
    ]);

    expect(operands(["get", "-c"], ["-c"])).toEqual(["get"]);
    expect(operands(["-v", "--", "-c", "x"], ["-c"])).toEqual(["-c", "x"]);
  });

  it("counts the leading words that may be an option's value", () => {
    expect(leadingValues(["-c", "prod", "-v", "x", "delete"])).toBe(2);
    expect(leadingValues(["--context=prod", "delete"])).toBe(0);
    expect(leadingValues(["-v", "-c"])).toBe(0);
    expect(leadingValues(["--", "x"])).toBe(0);
    expect(leadingValues(["status", "-c", "x"])).toBe(0);
  });
});
