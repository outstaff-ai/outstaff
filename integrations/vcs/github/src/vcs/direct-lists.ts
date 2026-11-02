import type { RepoRef } from "@outstaff/core";
import type {
  DirectCursor,
  RestEvent,
  RestIssueComment,
  RestPull,
  RestRepoReviewComment,
  RestReview,
} from "#/api.types.js";
import { toVcsEvent } from "#/event-mapping.js";
import { repoPath } from "./context.js";
import { OVERLAP_MS } from "./event-feed.js";
import type { DirectPosition, FoundEvent, PollGet } from "./types.js";

const PULLS_PAGE = 50;
const REVIEWS_PAGE = 100;

/** A list item as the feed would have reported it, so the feed's mapping (and its keys) apply unchanged. */
type AsFeed = Pick<RestEvent, "id" | "type" | "actor" | "created_at" | "payload">;

interface Read<T> {
  items: T[];

  /** The ETag to store for the list; undefined when GitHub sent none. */
  etag: string | undefined;
  changed: boolean;
}

interface Reader {
  get: PollGet;
  token: string;
  position: DirectPosition;
}

const parse = (at: string | null | undefined) => (at ? Date.parse(at) : Number.NaN);

/**
 * Where the lists of one repository start. A stored entry reads from its time less the overlap. Without one (the
 * first poll after the lists were added) they start at `start`, the feed's time, and nothing at or before it is news:
 * the feed already reported that under its event ids.
 */
export function directPosition(direct: DirectCursor | undefined, start: number): DirectPosition {
  const since = parse(direct?.since);
  if (Number.isNaN(since)) {
    return { since: start, after: start, floor: start + 1, etags: {}, reviewed: {} };
  }

  const { etags = {}, reviewed = {} } = direct!;
  const after = parse(direct!.after);
  const floor = Math.max(since - OVERLAP_MS, Number.isNaN(after) ? -Infinity : after + 1);
  return { since, after, floor, etags, reviewed };
}

/** One list, asked with the ETag of its last read; a 304 is no change and does not touch the rate limit. */
async function readList<T>(
  r: Reader,
  path: string,
  query: Record<string, string | number>,
): Promise<Read<T>> {
  const stored = r.position.etags[path];
  const res = await r.get<T[]>(path, {
    token: r.token,
    query,
    ...(stored ? { headers: { "if-none-match": stored } } : {}),
  });

  const etag = res.headers.get("etag") ?? stored;
  return res.status === 304
    ? { items: [], etag, changed: false }
    : { items: res.data, etag, changed: true };
}

const pullNumber = (url: string, pattern: RegExp) => {
  const n = pattern.exec(url)?.[1];
  return n === undefined ? undefined : Number(n);
};

/** A conversation comment on a pull request; the repository list also holds comments on issues, which are not. */
function fromIssueComment(c: RestIssueComment): AsFeed | undefined {
  const number = pullNumber(c.html_url, /\/pull\/(\d+)(?:#|$)/);
  if (number === undefined) {
    return undefined;
  }

  return {
    id: String(c.id),
    type: "IssueCommentEvent",
    actor: c.user,
    created_at: c.created_at,
    payload: { action: "created", issue: { number, pull_request: {} }, comment: c },
  };
}

function fromReviewComment(c: RestRepoReviewComment): AsFeed {
  return {
    id: String(c.id),
    type: "PullRequestReviewCommentEvent",
    actor: c.user,
    created_at: c.created_at,
    payload: {
      action: "created",
      pull_request: { number: pullNumber(c.pull_request_url, /\/pulls\/(\d+)$/) },
      comment: c,
    },
  };
}

function fromReview(number: number, r: RestReview): AsFeed {
  return {
    id: String(r.id),
    type: "PullRequestReviewEvent",
    actor: r.user,
    created_at: r.submitted_at!,
    payload: { action: "submitted", pull_request: { number }, review: r },
  };
}

/** The pull requests updated since the floor whose reviews have not been read at that update. */
function stalePulls(pulls: RestPull[], position: DirectPosition) {
  const recent = pulls.filter((p) => parse(p.updated_at) >= position.floor);
  const reviewed = Object.fromEntries(recent.map((p) => [String(p.number), p.updated_at]));
  const stale = recent.filter((p) => position.reviewed[String(p.number)] !== p.updated_at);
  return { reviewed, stale: stale.map((p) => p.number) };
}

/** The submitted reviews of one pull request: one page, so beyond its first 100 reviews the feed reports them. */
async function reviewsOf(r: Reader, repo: RepoRef, number: number): Promise<AsFeed[]> {
  const res = await r.get<RestReview[]>(`${repoPath(repo)}/pulls/${number}/reviews`, {
    token: r.token,
    query: { per_page: REVIEWS_PAGE },
  });

  return res.data
    .filter((v) => v.submitted_at && v.state !== "PENDING")
    .map((v) => fromReview(number, v));
}

/** Reviews have no repository list: the pulls list, newest first, says which pull requests moved. */
async function readReviews(r: Reader, repo: RepoRef) {
  const pulls = await readList<RestPull>(r, `${repoPath(repo)}/pulls`, {
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: PULLS_PAGE,
  });

  if (!pulls.changed) {
    return { etag: pulls.etag, reviewed: r.position.reviewed, items: [] };
  }

  const { reviewed, stale } = stalePulls(pulls.items, r.position);
  const items: AsFeed[] = [];
  for (const number of stale) {
    items.push(...(await reviewsOf(r, repo, number)));
  }

  return { etag: pulls.etag, reviewed, items };
}

/** The mapped items that are news, with the time and id they are ordered by. */
function found(repo: RepoRef, items: AsFeed[], floor: number): FoundEvent[] {
  return items
    .filter((e) => parse(e.created_at) >= floor)
    .map((e) => ({ event: toVcsEvent(repo, e)!, at: parse(e.created_at), id: BigInt(e.id) }));
}

function nextCursor(
  position: DirectPosition,
  times: number[],
  etags: Record<string, string | undefined>,
  reviewed: Record<string, string>,
): DirectCursor {
  const since = Math.max(position.since, ...times.filter((t) => !Number.isNaN(t)));
  const after = position.after >= since - OVERLAP_MS ? position.after : Number.NaN;
  const kept = Object.entries(etags).filter((e): e is [string, string] => e[1] !== undefined);
  return {
    since: new Date(since).toISOString(),
    ...(Number.isNaN(after) ? {} : { after: new Date(after).toISOString() }),
    ...(kept.length > 0 ? { etags: Object.fromEntries(kept) } : {}),
    ...(Object.keys(reviewed).length > 0 ? { reviewed } : {}),
  };
}

/**
 * Reads the comments and reviews of one repository from GitHub's direct lists, which are current at once, unlike
 * the events feed (which can lag by hours). Each item maps as the feed's would, under the same object key, so
 * whichever way it arrives first is the one recorded.
 */
export async function pollDirect(
  get: PollGet,
  token: string,
  repo: RepoRef,
  position: DirectPosition,
): Promise<{ cursor: DirectCursor; found: FoundEvent[] }> {
  const r: Reader = { get, token, position };
  // Oldest first: when more changed than a page holds, the next poll goes on from the newest of this one.
  const query = {
    since: new Date(position.floor).toISOString(),
    sort: "updated",
    direction: "asc",
    per_page: 100,
  };

  const issuesPath = `${repoPath(repo)}/issues/comments`;
  const pullsPath = `${repoPath(repo)}/pulls/comments`;
  const comments = await readList<RestIssueComment>(r, issuesPath, query);
  const inline = await readList<RestRepoReviewComment>(r, pullsPath, query);
  const reviews = await readReviews(r, repo);
  const items = [
    ...comments.items.map(fromIssueComment).filter((e) => e !== undefined),
    ...inline.items.map(fromReviewComment),
    ...reviews.items,
  ];

  const times = [
    ...comments.items.map((c) => parse(c.updated_at ?? c.created_at)),
    ...inline.items.map((c) => parse(c.updated_at)),
    ...reviews.items.map((e) => parse(e.created_at)),
  ];

  const etags = {
    [issuesPath]: comments.etag,
    [pullsPath]: inline.etag,
    [`${repoPath(repo)}/pulls`]: reviews.etag,
  };

  return {
    cursor: nextCursor(position, times, etags, reviews.reviewed),
    found: found(repo, items, position.floor),
  };
}
