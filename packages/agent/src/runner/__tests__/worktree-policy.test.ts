import { buildPolicy, evaluate, silentLogger, type Layout } from "@outstaff/core";
import { fakeEnv } from "@outstaff/testing.agent";
import { describe, expect, it, vi } from "vitest";
import type { Workspaces } from "#/repos/types.js";
import type { OfficeClient } from "#/verbs/index.js";
import { withWorktreeOwners } from "#/runner/worktree-policy.js";

const layout: Layout = {
  home: "/home/sam",
  workDir: "/home/sam/work",
  reposDir: "/home/sam/repos",
  worktreesDir: "/home/sam/worktrees",
  scratchDir: "/home/sam/scratch",
  memoryDir: "/home/sam/memory",
  secretsDir: "/run/secrets",
};

const team = {
  repos: [
    {
      name: "shop",
      url: "github.com/acme-example/shop",
      kind: "primary" as const,
      default_branch: "main",
    },
    {
      name: "shop-kit",
      url: "github.com/acme-example/shop-kit",
      kind: "other" as const,
      default_branch: "main",
    },
  ],
};

const person = { repos: { "*": "write" as const } };
const root = (repo: string, dir: string) => `/home/sam/worktrees/${repo}/${dir}`;

function setup() {
  const f = fakeEnv();
  f.office.prList = async () => ({
    prs: [
      {
        ref: "github.com/acme-example/shop-kit#1",
        number: 1,
        title: "Shared rule",
        state: "open",
        draft: true,
        author: "sam",
        ci: "none",
        mergeable: "clean",
        unresolvedThreads: 0,
        ticket: "ACME-150",
        updatedAt: "2026-11-03T10:00:00Z",
      },
    ],
    more: 0,
  });

  const work = vi.fn<OfficeClient["work"]>(async () => [
    {
      id: "w-150",
      title: "assigned: ACME-150",
      status: "waiting",
      ticketKey: "ACME-150",
    },
  ]);

  f.office.work = work;
  const workspaces = {
    worktrees: () => [
      { repo: "shop-kit", dir: "w-150", root: root("shop-kit", "w-150") },
      { repo: "shop", dir: "c-1", root: root("shop", "c-1") },
    ],
  } as unknown as Workspaces;

  return { env: f.env, work, workspaces };
}

describe("the round's policy names the work of another item's worktree", () => {
  it("in a chat session, a refused edit there says which work to attach to", async () => {
    const s = setup();
    const policy = await withWorktreeOwners(
      { env: s.env, workspaces: s.workspaces },
      buildPolicy({ profile: "chat", person, team, layout }),
      "c-1",
      silentLogger,
    );

    expect(policy.worktrees).toEqual([
      {
        root: root("shop-kit", "w-150"),
        hint: "This is the worktree of ACME-150 (shop-kit#1). To change it, attach the request to that work: ost work attach github.com/acme-example/shop-kit#1 --confirmed.",
      },
    ]);

    expect(
      evaluate(policy, {
        kind: "edit",
        path: `${root("shop-kit", "w-150")}/CONTRIBUTING.md`,
      }).reason,
    ).toMatch(/edit tools\. This is the worktree of ACME-150 \(shop-kit#1\)/);
  });

  it("in a work round that may not write there, says to leave the change to that work", async () => {
    const s = setup();
    const policy = await withWorktreeOwners(
      { env: s.env, workspaces: s.workspaces },
      buildPolicy({ profile: "readonly", person, team, layout }),
      "w-153",
      silentLogger,
    );

    expect(policy.worktrees?.map((w) => w.hint)).toEqual([
      "This is the worktree of ACME-150 (shop-kit#1), not of this item. Leave the change to that work: comment the request on its ticket ACME-150 or its pull request shop-kit#1, and say so in your hand-back.",
      expect.stringMatching(/^This is the worktree of another work item \(c-1\)/) as string,
    ]);

    expect(policy.worktrees?.some((w) => w.hint.includes("ost work attach"))).toBe(false);
  });

  it("asks the office nothing when the round may write every worktree", async () => {
    const s = setup();
    const base = buildPolicy({ profile: "code", person, team, layout });
    const policy = await withWorktreeOwners(
      { env: s.env, workspaces: s.workspaces },
      base,
      "w-153",
      silentLogger,
    );

    expect(policy).toBe(base);
    expect(s.work).not.toHaveBeenCalled();
  });

  it("is the policy as it is without workspaces", async () => {
    const base = buildPolicy({ profile: "chat", person, team, layout });
    expect(await withWorktreeOwners({ env: setup().env }, base, "c-1", silentLogger)).toBe(base);
  });
});
