import { evaluate, type Logger, type Policy } from "@outstaff/core";
import { safeId } from "#/repos/workspaces.js";
import { ownerHint, workIndex } from "#/verbs/worktree-owners.js";
import type { WorkLoopOptions } from "./loop.types.js";
import { reason } from "./reason.js";

/** Whether the policy refuses the edit tools anywhere in `root`. */
const refused = (policy: Policy, root: string) =>
  evaluate(policy, { kind: "write", path: `${root}/file` }).effect === "deny";

/**
 * The round's policy with the worktrees of the person's other work items it refuses to write, each with what a refusal
 * there says: the work it belongs to, and the `ost work attach` command for it in a chat session or, in a work round,
 * to leave the change to that work. Asks the office only when there is such
 * a worktree; without an answer the hint still says to look the work up.
 */
export async function withWorktreeOwners(
  opts: Pick<WorkLoopOptions, "workspaces" | "repos" | "env">,
  policy: Policy,
  workItemId: string,
  log: Logger,
): Promise<Policy> {
  const own = safeId(workItemId);
  const held = (opts.workspaces?.worktrees() ?? []).filter(
    (w) => w.dir !== own && refused(policy, w.root),
  );

  if (held.length === 0) {
    return policy;
  }

  const index = await workIndex(opts.env).catch((e: unknown) => {
    log.warn("could not list the work the worktrees belong to", { error: reason(e) });
    return { items: [], prs: [] };
  });

  // A chat session attaches the request to the owning work; a work round cannot, so it leaves the change there.
  const session = policy.profile === "chat" ? "chat" : "round";
  const refOf = (repo: string) =>
    opts.repos?.find((r) => r.name === repo)?.ref ?? { owner: "", name: repo };

  return {
    ...policy,
    worktrees: held.map((w) => ({
      root: w.root,
      hint: ownerHint(w.dir, refOf(w.repo), index, session),
    })),
  };
}
