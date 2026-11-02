import type { RestIssueComment, RestRepoReviewComment } from "@outstaff/integration.vcs.github";
import type { Route, StandInRequest } from "@outstaff/testing.http";
import { pullUrl } from "./model.js";
import type { GithubStore } from "./types.js";

/** Where the API URLs of the lists point. */
const API = "https://api.github.example";

/** A weak ETag of a list's answer: the same list is the same tag, so `If-None-Match` answers 304. */
function tagOf(items: unknown[]): string {
  let hash = 5381;
  for (const ch of JSON.stringify(items)) {
    hash = ((hash << 5) + hash + ch.charCodeAt(0)) | 0;
  }

  return `W/"${items.length}-${(hash >>> 0).toString(16)}"`;
}

/** The items changed at or after `since`, oldest change first, as `sort=updated&direction=asc` lists them. */
function listed<T extends { updated_at?: string }>(r: StandInRequest, items: T[]) {
  const since = Date.parse(r.query.get("since") ?? "");
  const kept = items
    .filter((i) => Number.isNaN(since) || Date.parse(i.updated_at!) >= since)
    .sort((a, b) => Date.parse(a.updated_at!) - Date.parse(b.updated_at!));

  const etag = tagOf(kept);
  return r.headers.get("if-none-match") === etag
    ? { status: 304 }
    : { headers: { etag }, body: kept };
}

function issueComments(s: GithubStore): RestIssueComment[] {
  return [...s.issueComments].map(([id, c]) => ({
    id,
    user: { login: c.author },
    body: c.body,
    created_at: c.at,
    updated_at: c.at,
    html_url: `${pullUrl(s, c.prNumber)}#issuecomment-${id}`,
  }));
}

/** The inline comments of submitted reviews, written when their review was. */
function reviewComments(s: GithubStore): RestRepoReviewComment[] {
  return [...s.reviews].flatMap(([id, v]) =>
    v.comments.map((c) => ({
      id: c.databaseId,
      user: { login: v.author },
      path: c.path,
      line: c.line,
      body: c.body,
      created_at: c.at,
      updated_at: c.at,
      pull_request_review_id: id,
      pull_request_url: `${API}/repos/${s.repo.owner}/${s.repo.name}/pulls/${v.prNumber}`,
      html_url: `${pullUrl(s, v.prNumber)}#discussion_r${c.databaseId}`,
    })),
  );
}

/**
 * The repository-wide comment lists, which are current at once where the events feed may lag. Registered before
 * the pull request routes, so `pulls/comments` is not read as pull request "comments".
 */
export function listRoutes(s: GithubStore, repo: string): Route[] {
  return [
    {
      method: "GET",
      path: `${repo}/issues/comments`,
      handler: (r) => listed(r, issueComments(s)),
    },
    {
      method: "GET",
      path: `${repo}/pulls/comments`,
      handler: (r) => listed(r, reviewComments(s)),
    },
  ];
}

/** The lists of a repository with nothing in them. */
export function emptyListRoutes(base: string): Route[] {
  return [`${base}/issues/comments`, `${base}/pulls/comments`].map((path) => ({
    method: "GET",
    path,
    handler: (r) => listed(r, []),
  }));
}
