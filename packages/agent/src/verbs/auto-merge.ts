import { PortError, type PullRequest, type RepoRef, type Vcs } from "@outstaff/core";
import { mergeOn, teamRepoName } from "./merge.js";
import type { AgentEnv } from "./types.js";

type AutoMergeVcs = Vcs & Required<Pick<Vcs, "enableAutoMerge" | "enqueue" | "mergeOptions">>;

const canAutoMerge = (vcs: Vcs): vcs is AutoMergeVcs =>
  Boolean(vcs.enableAutoMerge && vcs.enqueue && vcs.mergeOptions);

/** Whether the team lets agents set this repository's pull requests to merge (`policies.merge`). */
function allowed(env: AgentEnv, ref: RepoRef): boolean {
  const scope = env.team.policies?.merge.repos;
  const name = teamRepoName(env, ref);
  return mergeOn(env) && (!scope || (name !== undefined && scope.includes(name)));
}

/** A refusal the host gives for a pull request that cannot join the queue yet, for example before its approval. */
const notYet = (e: unknown) =>
  e instanceof PortError && (e.code === "invalid" || e.code === "conflict");

/**
 * Joins the merge queue where the repository has one, else turns on auto-merge. A pull request the queue does not
 * take yet gets auto-merge, which joins the queue once the repository's rules are met.
 */
async function setToMerge(vcs: AutoMergeVcs, ref: RepoRef, pr: PullRequest): Promise<string> {
  if ((await vcs.mergeOptions(ref, pr.base.ref)).queue) {
    try {
      await vcs.enqueue(ref, pr.number);
      return "Added to the merge queue: the host merges it when the queue passes.";
    } catch (e) {
      if (!notYet(e)) {
        throw e;
      }
    }
  }

  await vcs.enableAutoMerge(ref, pr.number);
  return "Auto-merge is on: the host merges it once the repository's required approvals and checks pass.";
}

/**
 * After a pull request became ready for review: when the team lets agents (`policies.merge.on_approval`, within
 * `policies.merge.repos`), the host is set to merge it, so no agent run is needed for the merge. Returns the line to
 * report, or nothing when merging is not the agent's to set. Never fails the verb: the pull request is ready either way.
 */
export async function autoMergeWhenReady(
  env: AgentEnv,
  vcs: Vcs,
  ref: RepoRef,
  pr: PullRequest,
): Promise<string | undefined> {
  if (pr.draft || pr.state !== "open" || !allowed(env, ref)) {
    return undefined;
  }

  if (!canAutoMerge(vcs)) {
    return "Auto-merge is not available on this code host: a person merges it.";
  }

  try {
    return await setToMerge(vcs, ref, pr);
  } catch (e) {
    return `Auto-merge was not turned on: ${(e as Error).message} Do not merge it another way; a person merges it.`;
  }
}
