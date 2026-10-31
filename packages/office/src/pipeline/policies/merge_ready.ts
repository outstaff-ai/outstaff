import {
  definePolicy,
  type PipelineCondition,
  type PipelineEvent,
  type PolicyContext,
} from "@outstaff/policy";
import { AGENT_PR_OPEN } from "./conditions.js";

/** Checks that let a merge go ahead: green, or none to wait for. */
const GREEN = new Set(["success", "none"]);

/** What a review must be to make the pull request ready: an allowed approver's approval. */
const APPROVAL: PipelineCondition = { all: [{ approver: true }, { review_state: ["approved"] }] };

/** Why the pull request is not ready to merge now, or undefined when it is. */
function notReady(event: PipelineEvent, ctx: PolicyContext): string | undefined {
  const pr = ctx.pr!;
  const scope = ctx.options.mergeRepos;
  const repo = `${pr.ref.repo.owner}/${pr.ref.repo.name}`.toLowerCase();
  if (scope && !scope.includes(repo)) {
    return `${repo} is not in policies.merge.repos`;
  }

  if (event.type === "pr.review_submitted" && !ctx.check(APPROVAL).ok) {
    return "the review is not an approval by an allowed approver (policies.merge.approvers)";
  }

  const ci = pr.ci ?? "none";
  return GREEN.has(ci) ? undefined : `its checks are ${ci}: the wake waits for them to pass`;
}

export const policy = definePolicy({
  id: "merge_ready",
  summary:
    "An agent's approved pull request that may be ready to merge wakes its author to decide (policies.merge.on_approval): an allowed approver approves it with its checks green, its checks turn green, or the pull request it was stacked on merges. Not while an allowed approver's request for changes is outstanding.",
  on: ["pr.review_submitted", "pr.ci_passed", "pr.base_merged"],
  when: { all: [AGENT_PR_OPEN, { pr_draft: false }, { pr_approved: true }] },
  instruction:
    "#{{pr.number}} ({{pr.title}}) is approved and may be ready to merge. Decide whether to merge it now, wait, or coordinate first; follow the repository's instructions on merging.",
  decides:
    "wake `author` (kind `merge`) with the merge context, when its checks are green and the repository is in `policies.merge.repos`",
  decide(event, ctx) {
    const why = notReady(event, ctx);
    return why
      ? [{ type: "drop", reason: `not ready to merge: ${why}` }]
      : ctx.wake({ person: "author", kind: "merge" });
  },
});
