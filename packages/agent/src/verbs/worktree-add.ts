import { PortError } from "@outstaff/core";
import { z } from "zod";
import { itemDirOf } from "#/repos/worktree-add.js";
import { defineVerb, result } from "./define.js";
import { resolveRepo } from "./support.js";
import type { AgentEnv } from "./types.js";
import { ownerHint, workIndex } from "./worktree-owners.js";

/** Why the branch cannot be checked out for this item: the work whose worktree has it, and how to reach that work. */
async function heldMessage(env: AgentEnv, repo: string, branch: string, heldBy: string) {
  const dir = env.layout ? itemDirOf(env.layout.worktreesDir, heldBy) : undefined;
  if (!dir) {
    return `${branch} is checked out in ${heldBy}, not in a work item's worktree, so no worktree is added. Name another branch.`;
  }

  // Only a work round adds a worktree, and a round cannot attach: it leaves the change to that work.
  const hint = ownerHint(dir, resolveRepo(env, repo), await workIndex(env), "round");
  return `${branch} is checked out in another work item's worktree (${heldBy}), so no worktree is added. ${hint}`;
}

export const worktreeAdd = defineVerb({
  name: "worktree.add",
  summary: "Add a worktree of another repository to this work item.",
  description:
    "For work that spans repositories: adds a worktree of another repository you have a write grant on to the current work item, at <worktrees>/<repo>/<item>. It is this item's from now on: edit, commit, push and open the pull request there like in the item's first worktree, in this round and later ones, and it is removed with the item. Without --branch it starts detached at the fetched default branch: create the branch with git switch -c before your first commit. With --branch it checks out that branch, from the remote when it exists, else a new one from the default branch. Refused for a repository you can only read or have no grant on, and for a branch another work item's worktree has checked out: that change belongs to that work, and the refusal names it.",
  input: z.strictObject({
    repo: z
      .string()
      .min(1)
      .max(300)
      .describe("The repository: its name in team.yaml, owner/name or its link."),
    branch: z
      .string()
      .min(1)
      .max(250)
      .regex(/^[^-\s]\S*$/, "a branch name, without spaces, not starting with -")
      .optional()
      .describe(
        "The branch to check out: an existing one (for example the head of a pull request), or a new one from the default branch.",
      ),
  }),
  args: ["repo"],
  examples: ["ost worktree add shop-kit", "ost worktree add shop-kit --branch feat/ACME-153-rule"],
  async run(env, input, ctx) {
    if (!ctx.workItemId || !env.workspaces) {
      throw new PortError(
        "invalid",
        "Only a work round adds a worktree. A chat session changes no repository: attach the request to the work it belongs to (ost work attach) or file it as new work.",
      );
    }

    const added = await env.workspaces.add(ctx.workItemId, input.repo, input.branch);
    if ("heldBy" in added) {
      throw new PortError(
        "conflict",
        await heldMessage(env, added.repo, input.branch ?? "", added.heldBy),
      );
    }

    const where = added.branch
      ? `on ${added.branch}`
      : "detached at the default branch: create the branch with git switch -c <name> before your first commit";

    return result(
      [
        added.existed
          ? `This item already has a worktree of ${added.repo}: ${added.worktree}, ${where}.`
          : `Added a worktree of ${added.repo} to this item: ${added.worktree}, ${where}.`,
        "Work there with the edit tools and git as in the item's first worktree; it stays this item's for its later rounds. Follow the convention files of that repository.",
      ],
      added,
      [],
    );
  },
});
