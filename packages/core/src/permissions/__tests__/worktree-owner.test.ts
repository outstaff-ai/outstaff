import { describe, expect, it } from "vitest";
import { buildPolicy, evaluate, type Layout, type Policy } from "#/index.js";

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
    { name: "shop", url: "github.com/acme/shop", kind: "primary" as const, default_branch: "main" },
    {
      name: "shop-kit",
      url: "github.com/acme/shop-kit",
      kind: "other" as const,
      default_branch: "main",
    },
  ],
};

const HINT =
  "This is the worktree of ACME-150 (shop-kit#1). To change it, attach the request to that work: ost work attach github.com/acme/shop-kit#1 --confirmed.";

const withOwners = (profile: "chat" | "docs" | "code"): Policy => ({
  ...buildPolicy({ profile, person: { repos: { "*": "write" } }, team, layout }),
  worktrees: [
    { root: "/work/worktrees/shop-kit", hint: "This is a worktree of shop-kit." },
    { root: "/work/worktrees/shop-kit/ACME-150", hint: HINT },
  ],
});

describe("a write refused in another work item's worktree", () => {
  it("names the work it belongs to and the attach command", () => {
    const d = evaluate(withOwners("chat"), {
      kind: "edit",
      path: "/work/worktrees/shop-kit/ACME-150/CONTRIBUTING.md",
    });

    expect(d).toEqual({
      effect: "deny",
      reason: `/work/worktrees/shop-kit/ACME-150/CONTRIBUTING.md is outside the paths this person may write with the edit tools. ${HINT}`,
      rule: "paths.write.outside",
    });
  });

  it("uses the deepest worktree that holds the path", () => {
    const d = evaluate(withOwners("docs"), {
      kind: "write",
      path: "/work/worktrees/shop-kit/ACME-150/src/a.ts",
    });

    expect(d.reason).toMatch(/ost work attach github.com\/acme\/shop-kit#1 --confirmed\.$/);
  });

  it("adds nothing outside the worktrees it knows", () => {
    const d = evaluate(withOwners("chat"), { kind: "edit", path: "/work/repos/shop/a.ts" });

    expect(d.reason).toBe(
      "/work/repos/shop/a.ts is outside the paths this person may write with the edit tools.",
    );
  });

  it("does not hint on reads or on writes the policy allows", () => {
    const policy = withOwners("code");

    expect(
      evaluate(policy, { kind: "edit", path: "/work/worktrees/shop-kit/ACME-150/a.ts" }).effect,
    ).toBe("allow");

    expect(
      evaluate(
        { ...policy, paths: { ...policy.paths, read: { allow: [], deny: [] } } },
        {
          kind: "read",
          path: "/work/worktrees/shop-kit/ACME-150/a.ts",
        },
      ).reason,
    ).not.toContain("ACME-150 (");
  });
});
