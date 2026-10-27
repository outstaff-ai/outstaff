import type { Offer } from "#/office-client/index.js";
import { headBranchOf, type ClonedRepo, type Workspace } from "#/repos/index.js";
import type { DocPath, WorkPromptOptions } from "./prompt.types.js";

function repoLine(r: ClonedRepo): string {
  const labels = r.trackerLabels.length
    ? `; tickets labeled ${r.trackerLabels.join(", ")} belong here`
    : "";

  return `- ${r.name} (${r.kind}, ${r.access}): ${r.ref.host}/${r.ref.owner}/${r.ref.name}${labels}`;
}

/** The repositories the person can work in, for every item but a chat session. */
export function repoLines(
  kind: Offer["workItem"]["kind"],
  repos: ClonedRepo[] | undefined,
): string[] {
  if (!repos?.length || kind === "chat") {
    return [];
  }

  return [
    "",
    "Your repositories (access is what you can do in them; a read-only one cannot take your change):",
    ...repos.map(repoLine),
  ];
}

function worktreeLine(w: Workspace, targetUnsettled: boolean, doc: DocPath): string {
  const where = w.branch ? `branch ${w.branch}` : "detached HEAD at the default branch";
  const settle = targetUnsettled
    ? ` That is the repository outstaff opened by default, not a decision about where the work belongs: settle the target repository as ${doc("process/work-items.md")} says before you change anything.`
    : "";

  return `Your worktree for this item is ${w.worktree} (repository ${w.repo}, ${where}). Scratch space: ${w.scratch}.${settle}`;
}

function pushLine(head: string | undefined, branch: string | undefined): string {
  if (head) {
    return `The branch to push to is ${head}, the head of your open pull request: git push origin HEAD:${head} (with --force-with-lease if you rewrite commits that are already pushed), so the pull request itself changes. Never open a new branch or pull request for this round, and never push to the default branch.`;
  }

  if (branch) {
    return "Commit there and push that branch; never push to the default branch.";
  }

  return "The worktree is on a detached HEAD at the default branch: no branch exists for this work yet, and outstaff does not name one. Once you know what the work is, and before your first commit, create the branch with git switch -c <name>. Name it the way the repository says (the convention files below); if it says nothing, use <type>/<ticket key>-<short slug>, for example feat/ACME-106-di-scopes, or <type>/<short slug> without a ticket. Keep the ticket key in the branch name or the pull request title. Then commit there and push that branch; never push to the default branch. If the item ends without code changes, create no branch.";
}

function conventionLine(files: string[], doc: DocPath): string {
  if (files.length) {
    return `The repository says how work is done in it. Read these files in the worktree before you change anything, and follow them for commits, branches, the pull request and checks: ${files.join(", ")}.`;
  }

  return `The repository has no contribution guide, agent guide or pull request template. Follow the defaults in ${doc("references/git.md")} and the style of its history.`;
}

/** Where the item's worktree is, which branch to push and how the repository wants work done. */
export function workspaceLines(offer: Offer, opts: WorkPromptOptions, doc: DocPath): string[] {
  const w = opts.workspace;
  if (!w) {
    return [];
  }

  const head = headBranchOf(offer);
  const targetUnsettled = (opts.repos?.length ?? 0) > 1 && !head;

  return [
    "",
    worktreeLine(w, targetUnsettled, doc),
    pushLine(head, w.branch),
    conventionLine(w.conventionFiles, doc),
  ];
}
