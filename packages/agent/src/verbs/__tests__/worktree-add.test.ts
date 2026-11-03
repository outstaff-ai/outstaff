import { PortError } from "@outstaff/core";
import { fakeEnv } from "@outstaff/testing.agent";
import { describe, expect, it, vi } from "vitest";
import type { AddedWorktree, Workspaces } from "#/repos/types.js";
import { findVerb, runVerb } from "#/verbs/index.js";
import { ownerHint, workIndex } from "#/verbs/worktree-owners.js";

const kit = { owner: "acme-example", name: "shop-kit" };

const pr = (ref: string, ticket?: string) => ({
  ref,
  number: Number(ref.split("#")[1]),
  title: "Shared rule",
  state: "open" as const,
  draft: true,
  author: "sam",
  ci: "none" as const,
  mergeable: "clean" as const,
  unresolvedThreads: 0,
  ...(ticket ? { ticket } : {}),
  updatedAt: "2026-11-03T10:00:00Z",
});

describe("what a refusal says about another item's worktree", () => {
  const index = {
    items: [
      {
        id: "w-150",
        title: "assigned: ACME-150",
        status: "waiting",
        ticketKey: "ACME-150",
      },
      {
        id: "w-151",
        title: "review",
        status: "queued",
        ticketKey: "ACME-151",
        pr: "github.com/acme-example/shop-kit#2",
      },
      { id: "w-152", title: "assigned: ACME-152", status: "queued", ticketKey: "ACME-152" },
      { id: "q/1", title: "Tidy the docs", status: "queued" },
    ],
    prs: [
      pr("github.com/acme-example/shop#1", "ACME-150"),
      pr("github.com/acme-example/shop-kit#1", "ACME-150"),
    ],
  };

  it("names the ticket and its pull request in that repository, and the attach command", () => {
    expect(ownerHint("w-150", kit, index, "chat")).toBe(
      "This is the worktree of ACME-150 (shop-kit#1). To change it, attach the request to that work: ost work attach github.com/acme-example/shop-kit#1 --confirmed.",
    );
  });

  it("uses the pull request an item is about", () => {
    expect(ownerHint("w-151", kit, index, "chat")).toContain(
      "ACME-151 (shop-kit#2). To change it, attach the request to that work: ost work attach github.com/acme-example/shop-kit#2 --confirmed.",
    );
  });

  it("falls back to the ticket, then to looking the work up", () => {
    expect(ownerHint("w-152", kit, index, "chat")).toContain(
      "ost work attach ACME-152 --confirmed.",
    );

    expect(ownerHint("q-1", kit, index, "chat")).toMatch(
      /^This is the worktree of work item q\/1 \("Tidy/,
    );

    expect(ownerHint("gone", kit, index, "chat")).toMatch(
      /another work item \(gone\).*ost work list/,
    );
  });

  it("in a work round, names the work the same way and leaves the change to it, without attach", () => {
    expect(ownerHint("w-150", kit, index, "round")).toBe(
      "This is the worktree of ACME-150 (shop-kit#1), not of this item. Leave the change to that work: comment the request on its ticket ACME-150 or its pull request shop-kit#1, and say so in your hand-back.",
    );

    expect(ownerHint("w-152", kit, index, "round")).toBe(
      "This is the worktree of ACME-152, not of this item. Leave the change to that work: comment the request on its ticket ACME-152, and say so in your hand-back.",
    );

    for (const dir of ["w-151", "q-1", "gone"]) {
      expect(ownerHint(dir, kit, index, "round")).not.toContain("ost work attach");
    }
  });

  it("is empty without an office, and survives one that fails", async () => {
    expect(await workIndex({})).toEqual({ items: [], prs: [] });
    const f = fakeEnv();
    f.office.work = () => Promise.reject(new Error("down"));
    expect(await workIndex(f.env)).toEqual({ items: [], prs: [] });
  });
});

describe("ost worktree add", () => {
  function setup(answer: AddedWorktree | Error) {
    const f = fakeEnv();
    const add = vi.fn<Workspaces["add"]>(async () => {
      if (answer instanceof Error) {
        throw answer;
      }

      return answer;
    });

    f.env.workspaces = { add };
    f.env.layout = {
      home: "/home/sam",
      workDir: "/home/sam/work",
      reposDir: "/home/sam/repos",
      worktreesDir: "/home/sam/worktrees",
      scratchDir: "/home/sam/scratch",
      memoryDir: "/home/sam/memory",
      secretsDir: "/run/secrets",
    };

    const run = (input: Record<string, unknown>, workItemId: string | null = "w-153") =>
      runVerb(findVerb("worktree.add")!, f.env, input, workItemId ? { workItemId } : {});

    return { ...f, add, run };
  }

  it("adds a worktree to the current item", async () => {
    const s = setup({
      repo: "design-system",
      worktree: "/home/sam/worktrees/design-system/w-153",
      branch: undefined,
      existed: false,
    });

    const r = await s.run({ repo: "design-system" });
    expect(s.add).toHaveBeenCalledWith("w-153", "design-system", undefined);
    expect(r.text).toContain(
      "Added a worktree of design-system to this item: /home/sam/worktrees/design-system/w-153, detached at the default branch",
    );
  });

  it("says when the item has it already", async () => {
    const s = setup({
      repo: "design-system",
      worktree: "/home/sam/worktrees/design-system/w-153",
      branch: "feat/x",
      existed: true,
    });

    const r = await s.run({ repo: "design-system", branch: "feat/x" });
    expect(r.text).toMatch(/already has a worktree of design-system: .*, on feat\/x\./);
  });

  it("names the work whose worktree has the branch, and the attach command", async () => {
    const s = setup({ repo: "design-system", heldBy: "/home/sam/worktrees/design-system/w-150" });
    s.office.work = async () => [
      { id: "w-150", title: "assigned", status: "waiting", ticketKey: "ACME-150" },
    ];

    await expect(s.run({ repo: "design-system", branch: "feat/x" })).rejects.toMatchObject({
      code: "conflict",
      message:
        "feat/x is checked out in another work item's worktree (/home/sam/worktrees/design-system/w-150), so no worktree is added. This is the worktree of ACME-150, not of this item. Leave the change to that work: comment the request on its ticket ACME-150, and say so in your hand-back.",
    });
  });

  it("asks for another branch when the base clone has it", async () => {
    const s = setup({ repo: "design-system", heldBy: "/home/sam/repos/design-system" });
    await expect(s.run({ repo: "design-system", branch: "main" })).rejects.toThrow(
      /main is checked out in \/home\/sam\/repos\/design-system, not in a work item's worktree/,
    );
  });

  it("passes on a refused grant", async () => {
    const s = setup(new PortError("forbidden", "You may only read design-system"));
    await expect(s.run({ repo: "design-system" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses outside a work round and a branch that reads as an option", async () => {
    const s = setup(new Error("unused"));
    await expect(s.run({ repo: "shop" }, null)).rejects.toThrow(/Only a work round/);
    await expect(s.run({ repo: "shop", branch: "--force" })).rejects.toThrow(/branch/);
    expect(s.add).not.toHaveBeenCalled();
  });
});
