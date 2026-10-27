import { PortError, type RepoRef } from "@outstaff/core";
import { z } from "zod";
import { repoLabel, requireVcs } from "./support.js";
import { defineVerb, result } from "./define.js";
import { checkMergeable, chooseMethod, mergeOn, requireMergeVcs, teamRepoName } from "./merge.js";
import { repoOrWorktree } from "./worktree.js";
import { number, repo } from "./pr-write-support.js";
import type { AgentEnv } from "./types.js";

export const prDiff = defineVerb({
  name: "pr.diff",
  summary: "Show the unified diff of a pull request.",
  description:
    "Prints the unified diff of a pull request after its link. Needs only read access; use it instead of gh pr diff.",
  input: z.strictObject({ repo, number }),
  args: ["number"],
  examples: ["ost pr diff 42"],
  async run(env, input, ctx) {
    const vcs = requireVcs(env);
    const ref = await repoOrWorktree(env, ctx, input.repo);
    const diff = await vcs.diff(ref, input.number);
    const url = vcs.links.pr(ref, input.number);
    return result(
      [`${repoLabel(ref)}#${input.number}`, url, "", diff.trimEnd() || "(empty diff)"],
      { diff },
      [url],
    );
  },
});

/** Refuses a repository outside `policies.merge.repos`, when the team limits merging to some repositories. */
function requireMergeScope(env: AgentEnv, ref: RepoRef): void {
  const scope = env.team.policies?.merge.repos;
  if (!scope) {
    return;
  }

  const name = teamRepoName(env, ref);
  if (!name || !scope.includes(name)) {
    throw new PortError(
      "forbidden",
      `${repoLabel(ref)} is not in policies.merge.repos (${scope.join(", ")}). Do not merge this pull request; leave it to a person.`,
    );
  }
}

export const prMerge = defineVerb({
  name: "pr.merge",
  summary: "Merge your own approved pull request, or put it in the merge queue.",
  description:
    "Merges your own pull request after an allowed approver approved it (policies.merge.approvers). Refused outright unless the team turned on policies.merge.on_approval. The code checks every condition and lists each one that fails: the pull request is yours, open, not a draft and mergeable; an allowed approver approved its current head and none has requested changes or still has a review pending; the required checks passed. Then it puts the pull request in the host's merge queue, or merges it with policies.merge.method (when that is unset, with what the repository has: its merge queue, else a method its settings allow). It never bypasses branch protection or rulesets: when the host refuses, report why and stop; do not merge another way.",
  input: z.strictObject({ repo, number }),
  args: ["number"],
  examples: ["ost pr merge 42"],
  async run(env, input, ctx) {
    if (!mergeOn(env)) {
      throw new PortError(
        "forbidden",
        "Merging is off for this team (policies.merge.on_approval is false). Do not merge this pull request; leave it to a person.",
      );
    }

    const vcs = requireMergeVcs(requireVcs(env));
    const ref = await repoOrWorktree(env, ctx, input.repo);
    const label = `${repoLabel(ref)}#${input.number}`;
    requireMergeScope(env, ref);
    const pr = await vcs.getPullRequest(ref, input.number, { waitForMergeable: true });
    const url = vcs.links.pr(ref, input.number);
    const problems = await checkMergeable(env, vcs, ref, pr);
    if (problems.length > 0) {
      throw new PortError(
        "conflict",
        `Not merged: ${label} cannot be merged yet.\n${problems.map((p) => `- ${p}`).join("\n")}\n${url}\nDo not merge it another way; report this and hand back.`,
      );
    }

    const options = await vcs.mergeOptions(ref, pr.base.ref);
    const method = chooseMethod(env.team.policies?.merge.method, options, repoLabel(ref));
    const done = await vcs.mergePullRequest(ref, input.number, { method, sha: pr.head.sha });
    const line =
      done.outcome === "queued"
        ? `Queued ${label} in the merge queue: ${pr.title}. The host merges it when the queue passes.`
        : `Merged ${label} (${method}): ${pr.title}`;

    return result([line, url], { outcome: done.outcome, method }, [url]);
  },
});
