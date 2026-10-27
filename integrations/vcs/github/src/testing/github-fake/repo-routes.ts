import type { RestCheckRun } from "../../api.types.js";
import { LOG_ORIGIN } from "./requests.js";
import type { FakeState, Route } from "../types.js";

/** A pull request and its diff, checks, job logs, statuses, permissions and the event feed. */
export function repoRoutes(s: FakeState): Route[] {
  const { repo, prs, checks, jobs, perms, events, rest, etag } = s;
  return [
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/:n`,
      handler: (r) => {
        const pr = prs.get(Number(r.params["n"]));
        if (!pr) {
          return { status: 404, body: { message: "Not Found" } };
        }

        return r.headers.get("accept") === "application/vnd.github.diff"
          ? {
              text: `diff --git a/${pr.head.ref}.txt b/${pr.head.ref}.txt\n--- a/${pr.head.ref}.txt\n+++ b/${pr.head.ref}.txt\n@@ -1 +1 @@\n-old\n+new\n`,
            }
          : rest(pr);
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/commits/:sha/check-runs`,
      handler: (r) => ({
        check_runs: (checks.get(r.params["sha"]!) ?? []).map((c): RestCheckRun => ({
          ...c,
          html_url: `https://github.example/runs/${c.name}`,
          details_url: c.job ? `https://github.example/acme/app/actions/runs/9/job/${c.id}` : null,
          app: { slug: c.job ? "github-actions" : "other-ci" },
        })),
      }),
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/actions/jobs/:id`,
      handler: (r) => {
        const job = jobs.get(Number(r.params["id"]));
        return job ? { steps: job.steps } : { status: 404, body: { message: "Not Found" } };
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/actions/jobs/:id/logs`,
      handler: (r) =>
        jobs.has(Number(r.params["id"]))
          ? { status: 302, headers: { location: `${LOG_ORIGIN}/logs/${r.params["id"]}?sig=abc` } }
          : { status: 404, body: { message: "Not Found" } },
    },
    {
      method: "GET",
      path: `${LOG_ORIGIN}/logs/:id`,
      handler: (r) => ({ text: jobs.get(Number(r.params["id"]))?.log ?? "" }),
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/commits/:sha/status`,
      handler: () => ({ statuses: [] }),
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/collaborators/:login/permission`,
      handler: (r) => ({ permission: perms.get(r.params["login"]!) ?? "none" }),
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/events`,
      handler: (r) =>
        r.headers.get("if-none-match") === etag()
          ? { status: 304 }
          : { headers: { etag: etag() }, body: events },
    },
  ];
}
