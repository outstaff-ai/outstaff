import { PortError, type Check, type RepoRef } from "@outstaff/core";
import type { RestCheckRun, RestWorkflowRun } from "#/api.types.js";
import { repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

/**
 * The workflow of each Actions check run on a commit, by its check suite: one read of the commit's workflow runs. Without
 * Actions: read the checks keep no workflow.
 */
async function workflowOfSuites(
  c: GithubContext,
  repo: RepoRef,
  sha: string,
  token: string,
): Promise<Map<number, string>> {
  try {
    const runs = await c.http.paginate<{ workflow_runs: RestWorkflowRun[] }, RestWorkflowRun>(
      `${repoPath(repo)}/actions/runs`,
      { token, query: { head_sha: sha, per_page: 100 } },
      (d) => d.workflow_runs,
    );

    return new Map(
      runs.flatMap((r) => (r.check_suite_id && r.name ? [[r.check_suite_id, r.name]] : [])),
    );
  } catch (e) {
    if (e instanceof PortError && e.code === "forbidden") {
      return new Map();
    }

    throw e;
  }
}

/** Names each check's workflow, for the check runs of a commit that belong to one. */
export async function withWorkflows(
  c: GithubContext,
  repo: RepoRef,
  sha: string,
  token: string,
  runs: RestCheckRun[],
  checks: Check[],
): Promise<Check[]> {
  if (!runs.some((r) => r.check_suite?.id)) {
    return checks;
  }

  const names = await workflowOfSuites(c, repo, sha, token);
  return checks.map((check, i) => {
    const workflow = names.get(runs[i]!.check_suite?.id ?? 0);
    return workflow ? { ...check, workflow } : check;
  });
}
