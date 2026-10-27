import { AdapterRegistry, buildPolicy, evaluate, type Decision, type Layout } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { githubVcs } from "#/index.js";

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
    { name: "site", url: "github.com/acme/site", kind: "other" as const, default_branch: "main" },
  ],
};

const packs = new AdapterRegistry().register(githubVcs).rulePacks();
const APP = "/work/worktrees/app/feat";
const SITE = "/work/repos/site";

const run = (command: string, cwd = APP, profile: "readonly" | "code" = "code"): Decision =>
  evaluate(
    buildPolicy({
      profile,
      person: { repos: { app: "write", site: "read" } },
      team,
      layout,
      packs,
    }),
    { kind: "shell", command, cwd },
  );

describe("GitHub adapter rule pack", () => {
  it("is one adapter pack", () => {
    expect(packs.map((p) => [p.id, p.source])).toEqual([["adapter.vcs.github", "adapter"]]);
  });

  it.each([
    "gh pr view 3",
    "gh pr checks 3",
    "gh pr diff 3",
    "gh pr create --title t",
    "gh pr merge 3",
    "gh api repos/acme/app/pulls",
    "gh api -X POST repos/acme/app/issues",
    "gh api graphql",
    "gh pr view 3 -R acme/other",
    "gh release create v1",
    "gh --version",
  ])("denies %s", (command) => {
    expect(run(command)).toMatchObject({ effect: "deny", rule: "gh.denied" });
  });

  it("denies gh in every profile and in repositories without a write grant", () => {
    expect(run("gh pr view 3", SITE, "readonly")).toMatchObject({
      effect: "deny",
      rule: "gh.denied",
    });

    expect(run("gh pr view 3", SITE)).toMatchObject({ effect: "deny", rule: "gh.denied" });
  });

  it("points at ost pr", () => {
    expect(run("gh pr create").reason).toContain("ost pr");
  });
});
