import type { Route } from "@outstaff/testing.http";
import { NOT_FOUND, UNAUTHORIZED, WEB } from "./model.js";
import type { GithubAuth, GithubStore } from "./types.js";

/** The one workflow run every Actions job belongs to (see `jobUrl`), and its workflow. */
export const RUN_ID = 9;
const WORKFLOW_ID = 1;

/** The run exists once a job of it was reported. */
const hasRun = (s: GithubStore, id: string | undefined) => Number(id) === RUN_ID && s.jobs.size > 0;

/**
 * Workflow runs as gh reads and re-runs them (`gh run view`, `gh run rerun`): the run, its workflow, and a re-run,
 * which is recorded with who asked for it.
 */
export function actionsRoutes(s: GithubStore, auth: GithubAuth, repo: string): Route[] {
  const rerun = (verb: string, failedOnly: boolean): Route => ({
    method: "POST",
    path: `${repo}/actions/runs/:id/${verb}`,
    handler: (r) => {
      const actor = auth.actorOf(r);
      if (!actor) {
        return UNAUTHORIZED;
      }

      if (!hasRun(s, r.params["id"])) {
        return NOT_FOUND;
      }

      s.reruns.push({ runId: RUN_ID, actor, failedOnly });
      return { status: 201, body: {} };
    },
  });

  return [
    {
      method: "GET",
      path: `${repo}/actions/runs/:id`,
      handler: (r) =>
        hasRun(s, r.params["id"])
          ? {
              id: RUN_ID,
              name: "CI",
              workflow_id: WORKFLOW_ID,
              status: "completed",
              conclusion: "failure",
              event: "push",
              run_attempt: 1 + s.reruns.length,
              html_url: `${WEB}/${s.repo.owner}/${s.repo.name}/actions/runs/${RUN_ID}`,
            }
          : NOT_FOUND,
    },
    {
      method: "GET",
      path: `${repo}/actions/workflows/:id`,
      handler: (r) =>
        Number(r.params["id"]) === WORKFLOW_ID
          ? { id: WORKFLOW_ID, name: "CI", path: ".github/workflows/ci.yml", state: "active" }
          : NOT_FOUND,
    },
    rerun("rerun", false),
    rerun("rerun-failed-jobs", true),
  ];
}
