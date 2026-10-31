import type { ApiDevLink, ApiDevPullRequestPage } from "@outstaff/integration.shared.itsaplan";
import type { StandInRequest } from "@outstaff/testing.http";
import { issueById } from "./model.js";
import { err } from "./store.js";
import type { ActorRoute, ItsaplanStore, StoredIssue, StoredRepository } from "./types.js";

/** Pull requests per page of the listing; small, so that paging is exercised. */
export const PULL_REQUEST_PAGE = 20;

type Found = { issue: StoredIssue; repo: StoredRepository } | { reply: ReturnType<typeof err> };

/** The issue and the connected repository a request names, or the 404 Its a Plan answers. */
function issueAndRepo(s: ItsaplanStore, r: StandInRequest, repositoryId: unknown): Found {
  const issue = issueById(s, r.params["id"]!);
  const repo = s.repositories.find((x) => x.id === Number(repositoryId));
  if (!issue) {
    return { reply: err(404, "issue not found") };
  }

  return repo ? { issue, repo } : { reply: err(404, "repository not found") };
}

const isLinked = (s: ItsaplanStore, issueId: number, repositoryId: number, number: number) =>
  s.development.some(
    (l) => l.issueId === issueId && l.repositoryId === repositoryId && l.number === number,
  );

/** One page of a repository's pull requests (open ones unless `state=all`), each saying whether it is linked. */
async function listPullRequests(s: ItsaplanStore, r: StandInRequest) {
  const found = issueAndRepo(s, r, r.params["repositoryId"]);
  if ("reply" in found) {
    return found.reply;
  }

  const { issue, repo } = found;
  const all = r.query.get("state") === "all";
  const page = Number(r.query.get("page") ?? 1);
  const prs = (await s.pullRequestsOf(repo)).filter((p) => all || p.state === "open");
  const start = (page - 1) * PULL_REQUEST_PAGE;
  return {
    pullRequests: prs
      .slice(start, start + PULL_REQUEST_PAGE)
      .map((p) => ({ ...p, linked: isLinked(s, issue.id, repo.id, p.number) })),
    nextPage: start + PULL_REQUEST_PAGE < prs.length ? page + 1 : null,
  } satisfies ApiDevPullRequestPage;
}

/** Links a pull request of a connected repository on the issue; linking it again answers the link that exists. */
async function link(s: ItsaplanStore, r: StandInRequest, actor: string) {
  const found = issueAndRepo(s, r, r.json.repositoryId);
  if ("reply" in found) {
    return found.reply;
  }

  const { issue, repo } = found;
  const number = Number(r.json.number);
  const pr = (await s.pullRequestsOf(repo)).find((p) => p.number === number);
  if (!pr) {
    return err(404, "pull request not found");
  }

  const known = s.development.find(
    (l) => l.issueId === issue.id && l.repositoryId === repo.id && l.number === number,
  );

  const row = known ?? {
    id: ++s.counters.link,
    issueId: issue.id,
    repositoryId: repo.id,
    number,
    by: actor,
  };

  if (!known) {
    s.development.push(row);
  }

  const body: ApiDevLink = {
    id: row.id,
    provider: repo.provider,
    repository: repo.fullName,
    kind: "pull_request",
    number,
    title: pr.title,
    url: pr.url,
  };

  return { status: known ? 200 : 201, body };
}

/** An issue's development section: the connected repositories, their pull requests, and linking one. */
export function developmentRoutes(s: ItsaplanStore): ActorRoute[] {
  return [
    {
      method: "GET",
      path: "/issues/:id/development/repositories",
      handler: (r) =>
        issueById(s, r.params["id"]!) ? s.repositories : err(404, "issue not found"),
    },
    {
      method: "GET",
      path: "/issues/:id/development/repositories/:repositoryId/pull-requests",
      handler: (r) => listPullRequests(s, r),
    },
    { method: "POST", path: "/issues/:id/development", handler: (r, actor) => link(s, r, actor) },
  ];
}
