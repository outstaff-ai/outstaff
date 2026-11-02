import type { RestCheckRun } from "@outstaff/integration.vcs.github";
import type { Route } from "@outstaff/testing.http";
import { branchRoutes } from "./branch-routes.js";
import { NOT_FOUND, WEB, etag } from "./model.js";
import type { GithubStore, StandInRepo, StoredCheckRun } from "./types.js";

/** Where Actions job logs are downloaded from, after a redirect. */
export const LOG_ORIGIN = "https://logs.github.test";

/** The link of an Actions job, as GitHub gives it to the job's check run. */
export const jobUrl = (s: GithubStore, id: number) =>
  `${WEB}/${s.repo.owner}/${s.repo.name}/actions/runs/9/job/${id}`;

const checkRun = (s: GithubStore, c: StoredCheckRun): RestCheckRun => ({
  id: c.id,
  name: c.name,
  status: c.status,
  conclusion: c.conclusion,
  html_url: c.html_url ?? (c.job ? jobUrl(s, c.id) : `${WEB}/runs/${c.name}`),
  details_url: c.job ? jobUrl(s, c.id) : null,
  app: { slug: c.job ? "github-actions" : "other-ci" },
  ...(c.output ? { output: c.output } : {}),
});

/** Where a log redirect points, and the route that serves it: on its own origin, or under a path of this server. */
function logPlace(s: GithubStore) {
  const base = s.logUrl ?? `${LOG_ORIGIN}/logs`;
  return { base, route: s.logUrl ? `${new URL(s.logUrl).pathname}/:id` : `${base}/:id` };
}

/** Checks, Actions jobs and their logs, commit statuses, permissions and the event feed. */
export function repoRoutes(s: GithubStore, repo: string): Route[] {
  const logs = logPlace(s);
  return [
    {
      method: "GET",
      path: `${repo}/commits/:sha/check-runs`,
      handler: (r) => ({
        check_runs: (s.checks.get(r.params["sha"]!) ?? []).map((c) => checkRun(s, c)),
      }),
    },
    {
      method: "GET",
      path: `${repo}/actions/jobs/:id`,
      handler: (r) => {
        const job = s.jobs.get(Number(r.params["id"]));
        return job ? { steps: job.steps } : NOT_FOUND;
      },
    },
    {
      method: "GET",
      path: `${repo}/actions/jobs/:id/logs`,
      handler: (r) =>
        s.jobs.has(Number(r.params["id"]))
          ? { status: 302, headers: { location: `${logs.base}/${r.params["id"]}?sig=abc` } }
          : NOT_FOUND,
    },
    {
      method: "GET",
      path: logs.route,
      handler: (r) => ({ text: s.jobs.get(Number(r.params["id"]))?.log ?? "" }),
    },
    { method: "GET", path: `${repo}/commits/:sha/status`, handler: () => ({ statuses: [] }) },
    {
      method: "GET",
      path: `${repo}/collaborators/:login/permission`,
      handler: (r) => ({ permission: s.perms.get(r.params["login"]!) ?? "none" }),
    },
    {
      method: "GET",
      path: `${repo}/events`,
      handler: (r) =>
        r.headers.get("if-none-match") === etag(s)
          ? { status: 304 }
          : { headers: { etag: etag(s) }, body: s.events },
    },
  ];
}

/** Further repositories have no pull requests, no events and an unprotected branch; the office still polls them. */
export function moreRoutes(s: GithubStore, api: string, more: StandInRepo[]): Route[] {
  return more.flatMap((m): Route[] => {
    const base = `${api}/repos/${m.owner}/${m.name}`;
    return [
      { method: "GET", path: base, handler: () => ({ default_branch: "main" }) },
      ...branchRoutes({ rules: [] }, base),
      { method: "GET", path: `${base}/pulls`, handler: () => [] },
      {
        method: "GET",
        path: `${base}/events`,
        handler: () => ({ headers: { etag: '"none"' }, body: [] }),
      },
      {
        method: "GET",
        path: `${base}/collaborators/:login/permission`,
        handler: (r) => ({ permission: s.perms.get(r.params["login"]!) ?? "none" }),
      },
    ];
  });
}
