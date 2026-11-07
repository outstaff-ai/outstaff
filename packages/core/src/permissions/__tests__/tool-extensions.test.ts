import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseTeamConfig } from "#/config/parse.js";
import {
  buildPolicy,
  evaluate,
  extensionsToPack,
  isPinnedRef,
  parseToolExtension,
  toolsToPacks,
  type EffectiveTool,
  type Layout,
  type RulePack,
} from "#/index.js";

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

const issues = (extensions: string) => {
  const r = parseTeamConfig(
    parse(`${BASE}tools:\n  gh: { version: 2.103.3, extensions: ${extensions} }\n`),
  );

  return r.ok
    ? []
    : r.issues.filter((i) => i.code.startsWith("tools.")).map((i) => [i.code, i.path.join(".")]);
};

describe("tool extensions in team.yaml", () => {
  it.each([
    "[acme/gh-hello@v1.2.0]",
    "[acme/gh-hello@1.2.0]",
    "[acme/gh-hello@v1.2.0-rc.1]",
    `[acme/gh-hello@${"a".repeat(40)}]`,
    "[acme/gh-hello@v1.0.0, acme/gh-other@v2.0.0]",
  ])("accepts pinned %s", (list) => {
    expect(issues(list)).toEqual([]);
  });

  it.each([
    "[acme/gh-hello@main]",
    "[acme/gh-hello@latest]",
    "[acme/gh-hello@v1]",
    "[acme/gh-hello@abc1234]",
  ])("refuses unpinned %s", (list) => {
    expect(issues(list)).toEqual([["tools.unpinned_extension", "tools.gh.extensions.0"]]);
  });

  it.each(["[acme/gh-hello]", "[gh-hello@v1.0.0]", "[https://github.com/acme/gh-hello@v1.0.0]"])(
    "refuses %s, which is not owner/name@ref",
    (list) => {
      expect(issues(list)).toEqual([["tools.invalid_extension", "tools.gh.extensions.0"]]);
    },
  );

  it("refuses an extension listed twice", () => {
    expect(issues("[acme/gh-hello@v1.0.0, Acme/gh-hello@v2.0.0]")).toEqual([
      ["tools.duplicate", "tools.gh.extensions.1"],
    ]);
  });

  it("parses owner, name and ref", () => {
    expect(parseToolExtension("github/gh-actions-lock@v1.2.0")).toEqual({
      owner: "github",
      name: "gh-actions-lock",
      ref: "v1.2.0",
    });

    expect(parseToolExtension("gh-actions-lock")).toBeUndefined();
    expect(isPinnedRef("v1.2.0")).toBe(true);
    expect(isPinnedRef("main")).toBe(false);
  });
});

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

/** An adapter that narrows gh to `run view` and denies installing extensions, as the GitHub adapter does. */
const adapter: RulePack = {
  id: "adapter.vcs.test",
  source: "adapter",
  rules: [
    {
      id: "gh.allow.run.view",
      program: "gh",
      subcommand: ["run", "view"],
      effect: "allow",
      reason: "r",
    },
    {
      id: "gh.extension-install",
      program: "gh",
      subcommand: ["extension", "install"],
      effect: "deny",
      reason: "declared only",
    },
  ],
};

const LOCK = { tool: "gh", command: "actions-lock", extension: "github/gh-actions-lock@v1.2.0" };

function decide(tool: EffectiveTool, command: string) {
  const ext = extensionsToPack([LOCK], [tool]);
  const policy = buildPolicy({
    profile: "code",
    person: { repos: { app: "write" } },
    team,
    layout,
    packs: [adapter, ...toolsToPacks([tool]), ...(ext ? [ext] : [])],
  });

  return evaluate(policy, { kind: "shell", command, cwd: "/work/worktrees/app/x" });
}

const gh = (extra: Partial<EffectiveTool> = {}): EffectiveTool => ({
  name: "gh",
  version: "2.103.3",
  origin: "team",
  ...extra,
});

describe("extensionsToPack", () => {
  it("allows a declared extension's command, past the adapter's narrowing", () => {
    expect(decide(gh(), "gh actions-lock --check")).toMatchObject({
      effect: "allow",
      rule: "tools.gh.extension.actions-lock",
    });
  });

  it("leaves an undeclared extension's command refused", () => {
    expect(decide(gh(), "gh hello")).toMatchObject({ effect: "deny", rule: "commands.narrowed" });
  });

  it("keeps installing extensions denied", () => {
    expect(decide(gh(), "gh extension install acme/gh-hello")).toMatchObject({
      effect: "deny",
      rule: "gh.extension-install",
    });
  });

  it("lets the tool's allow entries narrow the extension's command", () => {
    const tool = gh({ allow: ["actions-lock check"] });
    expect(extensionsToPack([LOCK], [tool])).toBeUndefined();
    expect(decide(tool, "gh actions-lock check")).toMatchObject({ effect: "allow" });
    expect(decide(tool, "gh actions-lock write")).toMatchObject({ effect: "deny" });
  });

  it("lets structured allow rules narrow it too", () => {
    const tool = gh({ allow: [{ subcommand: ["actions-lock", "check"], reason: "check only" }] });
    expect(extensionsToPack([LOCK], [tool])).toBeUndefined();
  });

  it("makes nothing without extensions", () => {
    expect(extensionsToPack([], [gh()])).toBeUndefined();
  });
});
