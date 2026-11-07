import {
  AdapterRegistry,
  buildPolicy,
  evaluate,
  toolsToPacks,
  type Decision,
  type Layout,
} from "@outstaff/core";
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
    "gh run view 9 --log-failed",
    "gh run list -L 5",
    "gh run watch 9",
    "gh run rerun 9 --failed",
    "gh run cancel 9",
    "gh run download 9 -D /work/scratch/x",
    "gh workflow run deploy.yml -f env=staging",
    "gh workflow view deploy.yml",
    "gh workflow list",
    "gh pr view 3 --json title",
    "gh pr checks 3",
    "gh pr diff 3",
    "gh pr list --state open",
    "gh api repos/acme/app/actions/runs",
    "gh api -X GET repos/acme/app/actions/runs -f status=failure",
    "gh api --method=get repos/acme/app/pulls",
    "gh api -H 'Accept: application/vnd.github+json' repos/acme/app",
    "gh pr view 3 -R acme/site",
  ])("allows %s", (command) => {
    expect(run(command)).toMatchObject({ effect: "allow" });
  });

  it.each([
    ["gh pr merge 3 --squash", "gh.pr-merge"],
    ["gh pr review 3 --approve", "gh.pr-approve"],
    ["gh pr review 3 -a", "gh.pr-approve"],
    ["gh repo delete acme/app --yes", "gh.repo-delete"],
    ["gh repo edit --visibility public", "gh.repo-edit"],
    ["gh secret list", "gh.secret"],
    ["gh secret set TOKEN", "gh.secret"],
    ["gh api -X POST repos/acme/app/issues", "gh.api-method"],
    ["gh api -XDELETE repos/acme/app", "gh.api-method"],
    ["gh api --method=PATCH repos/acme/app", "gh.api-method"],
    ["gh api repos/acme/app/issues -f title=x", "gh.api-fields"],
    ["gh api repos/acme/app/issues --input body.json", "gh.api-fields"],
    ["gh api graphql -f query=x -X GET", "gh.api-graphql"],
    ["gh api -H 'Accept: x' graphql -X GET", "gh.api-graphql"],
    ["gh extension install github/gh-actions-lock --pin v1.2.0", "gh.extension-install"],
    ["gh ext install acme/gh-hello", "gh.ext-install"],
    ["gh extensions upgrade --all", "gh.extensions-upgrade"],
    ["gh extension remove actions-lock", "gh.extension-remove"],
  ])("denies %s by %s", (command, rule) => {
    expect(run(command)).toMatchObject({ effect: "deny", rule });
  });

  it.each([
    "gh pr create --title t",
    "gh release create v1",
    "gh auth token",
    "gh --version",
    "gh actions-lock",
    "gh extension exec actions-lock",
  ])("refuses %s, which no rule allows", (command) => {
    expect(run(command)).toMatchObject({ effect: "deny", rule: "commands.narrowed" });
  });

  it("allows the same reads in every profile, and still denies a merge", () => {
    expect(run("gh run view 9", SITE, "readonly")).toMatchObject({ effect: "allow" });
    expect(run("gh pr merge 3", SITE, "readonly")).toMatchObject({ rule: "gh.pr-merge" });
  });

  it("points a merge at ost pr merge", () => {
    expect(run("gh pr merge 3").reason).toContain("ost pr merge");
  });

  it("keeps its narrowing when the team installs gh as a tool without allow", () => {
    const policy = buildPolicy({
      profile: "code",
      person: { repos: { app: "write" } },
      team,
      layout,
      packs: [...packs, ...toolsToPacks([{ name: "gh", version: "2.103.3", origin: "team" }])],
    });

    const shell = (command: string) => evaluate(policy, { kind: "shell", command, cwd: APP });
    expect(shell("gh release create v1")).toMatchObject({ rule: "commands.narrowed" });
    expect(shell("gh run rerun 9")).toMatchObject({ effect: "allow" });
  });

  it("keeps installing extensions denied when the team allows it", () => {
    const tool = { name: "gh", version: "2.103.3", origin: "team" as const };
    const policy = buildPolicy({
      profile: "code",
      person: { repos: { app: "write" } },
      team,
      layout,
      packs: [...packs, ...toolsToPacks([{ ...tool, allow: ["extension install"] }])],
    });

    expect(
      evaluate(policy, { kind: "shell", command: "gh extension install acme/gh-x", cwd: APP }),
    ).toMatchObject({ effect: "deny", rule: "gh.extension-install" });
  });
});
