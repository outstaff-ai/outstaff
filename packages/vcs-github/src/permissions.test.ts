import { AdapterRegistry, buildPolicy, evaluate, type Decision, type Layout } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { githubVcs } from "./index.js";

const layout: Layout = {
  home: "/home/agent",
  workDir: "/work",
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
    ["gh pr view 3", APP],
    ["gh pr checks 3", APP],
    ["gh pr diff 3", SITE],
    ["gh api repos/acme/app/pulls", APP],
    ["gh api -X GET repos/acme/app/pulls", APP],
    ["gh api --method=get repos/acme/app/pulls", SITE],
  ])("allows %s", (command, cwd) => {
    expect(run(command, cwd).effect).toBe("allow");
  });

  it("allows reads for the readonly profile too", () => {
    expect(run("gh pr view 3", SITE, "readonly").effect).toBe("allow");
  });

  it.each([
    ["gh api -X POST repos/acme/app/issues", "gh.api.method"],
    ["gh api --method=DELETE repos/acme/app/git/refs/heads/x", "gh.api.method"],
    ["gh api -XPATCH repos/acme/app/pulls/1", "gh.api.method"],
    ["gh api repos/acme/app/issues -f title=x", "gh.api.body"],
    ["gh api repos/acme/app/issues --input body.json", "gh.api.body"],
    ["gh api graphql -f query=@q", "gh.api.body"],
    ["gh api /graphql", "gh.api.graphql"],
    ["gh api graphql", "gh.api.graphql"],
    ["gh pr create --title t", "gh.pr.create"],
    ["gh pr edit 3 --title x", "gh.pr.edit"],
    ["gh pr merge 3", "gh.pr.merge"],
    ["gh pr comment 3 --body hi", "gh.pr.comment"],
  ])("denies %s", (command, rule) => {
    expect(run(command)).toMatchObject({ effect: "deny", rule });
  });

  it("points PR changes at ost pr", () => {
    expect(run("gh pr create").reason).toContain("ost pr");
  });

  it("asks outside granted repositories and for -R targets", () => {
    expect(run("gh pr view 3", "/work/scratch")).toMatchObject({
      effect: "ask",
      rule: "git.no-repo",
    });

    expect(run("gh pr view 3 -R acme/other")).toMatchObject({
      effect: "ask",
      rule: "commands.repo-flag",
    });
  });

  it("does not cover other gh commands", () => {
    expect(run("gh release create v1").effect).toBe("ask");
  });
});
