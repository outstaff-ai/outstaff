import type { Offer } from "#/office-client/index.js";
import { headBranchOf, type ClonedRepo, type RepoHead, type Workspace } from "#/repos/index.js";
import type { DocPath, WorkPromptOptions } from "./prompt.types.js";

function repoLine(r: ClonedRepo): string {
  const labels = r.trackerLabels.length
    ? `; tickets labeled ${r.trackerLabels.join(", ")} belong here`
    : "";

  return `- ${r.name} (${r.kind}, ${r.access}): ${r.ref.host}/${r.ref.owner}/${r.ref.name}${labels}`;
}

function headText(r: ClonedRepo, head: RepoHead | undefined): string {
  const commit = head?.commit ? `commit ${head.commit.slice(0, 12)}` : "an unknown commit";
  if (head?.atDefault) {
    return `${commit}, the latest origin/${r.defaultBranch} fetched`;
  }

  return `${commit}, which may not be the latest origin/${r.defaultBranch}: the clone has local changes or could not be fetched`;
}

/** The base clones a chat session reads, with the commit each is at. */
function readableLines(repos: ClonedRepo[], heads: RepoHead[]): string[] {
  const line = (r: ClonedRepo) =>
    `- ${r.name}: ${r.dir}, at ${headText(
      r,
      heads.find((h) => h.name === r.name),
    )}`;

  return [
    "",
    "The repositories you can read, refreshed when this session started and each at the commit shown (a change merged since is not in them yet):",
    ...repos.map(line),
  ];
}

/** The repositories the person can work in, or for a chat session the clones it reads. */
export function repoLines(
  kind: Offer["workItem"]["kind"],
  repos: ClonedRepo[] | undefined,
  heads?: RepoHead[],
): string[] {
  if (!repos?.length) {
    return [];
  }

  if (kind === "chat") {
    return heads ? readableLines(repos, heads) : [];
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
    ...othersLine(w),
    pushLine(head, w.branch),
    conventionLine(w.conventionFiles, doc),
  ];
}

/** The worktrees an earlier round added in other repositories with `ost worktree add`. */
function othersLine(w: Workspace): string[] {
  if (!w.others?.length) {
    return [];
  }

  const list = w.others.map((o) => `${o.worktree} (repository ${o.repo})`).join(", ");
  return [
    `This item also has worktrees in other repositories, added in an earlier round: ${list}. Work there as in the first one, by that repository's convention files.`,
  ];
}
