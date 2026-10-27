import type { RepoRef, UnmappedEvent } from "@outstaff/core";
import { nextLink } from "../http.js";
import type { HttpResult } from "../types.js";
import { toVcsEvent } from "../event-mapping.js";
import type { Cursor, RestEvent } from "../api.types.js";
import { repoPath } from "./context.js";
import type { FeedPosition, FoundEvent, GithubContext, RepoPoll } from "./types.js";

const EVENT_PAGES = 3;
// Re-read this much before the newest time seen; intake de-duplicates by external id.
const OVERLAP_MS = 5 * 60_000;

/** Where the stored cursor entry of a repository says its feed was left off. */
export function feedPosition(entry: Cursor[string] | undefined, hasCursor: boolean): FeedPosition {
  // An entry without a valid `since` (new repo, or a cursor from before times were tracked) is no entry.
  const since = typeof entry?.since === "string" ? Date.parse(entry.since) : Number.NaN;
  const unknown = Number.isNaN(since);
  return {
    since,
    unknown,
    // No cursor at all is the first poll: intake decides whether that history is a baseline.
    // A cursor that lacks this repository only baselines this repository (#229).
    baseline: unknown && hasCursor,
    etag: unknown ? undefined : entry?.etag,
    skip: new Set(unknown ? [] : entry?.seen),
  };
}

/** The time below which an event is old news. */
function feedFloor(position: FeedPosition, firstPage: RestEvent[]): number {
  const top = position.unknown
    ? Math.max(...firstPage.map((e) => Date.parse(e.created_at)))
    : position.since;

  return top - OVERLAP_MS;
}

/** Whether the page links to an older one that may still hold events at or above the floor. */
function olderPageLink(
  c: GithubContext,
  res: HttpResult<RestEvent[]>,
  floor: number,
): string | undefined {
  const link = nextLink(res.headers.get("link"), c.apiUrl);
  const oldest = res.data.at(-1);
  return oldest && Date.parse(oldest.created_at) >= floor ? link : undefined;
}

/** Follows the feed back from its first page; GitHub event ids are not one sequence, so this pages by time. */
async function readOlderPages(
  c: GithubContext,
  token: string,
  first: HttpResult<RestEvent[]>,
  floor: number,
): Promise<RestEvent[]> {
  const raw = [...first.data];
  let res = first;
  for (let page = 1; page < EVENT_PAGES; page++) {
    const link = olderPageLink(c, res, floor);
    if (!link) {
      break;
    }

    res = await c.http.request<RestEvent[]>("GET", link, { token });
    raw.push(...res.data);
  }

  return raw;
}

function unmappedEvent(repo: RepoRef, e: RestEvent): UnmappedEvent {
  const action = e.payload["action"];
  return {
    externalId: e.id,
    type: typeof action === "string" ? `${e.type} (${action})` : e.type,
    repo,
  };
}

/** Sorts the new events of the feed into those the office acts on and those it does not map. */
function collect(repo: RepoRef, raw: RestEvent[], position: FeedPosition, floor: number) {
  const found: FoundEvent[] = [];
  const unmapped: UnmappedEvent[] = [];
  if (position.baseline) {
    return { found, unmapped };
  }

  const fresh = raw.filter((e) => {
    const at = Date.parse(e.created_at);
    return !Number.isNaN(at) && at >= floor && !position.skip.has(e.id);
  });

  for (const e of fresh) {
    const event = toVcsEvent(repo, e);
    if (event) {
      found.push({ event, at: Date.parse(e.created_at), id: BigInt(e.id) });
    } else {
      unmapped.push(unmappedEvent(repo, e));
    }
  }

  return { found, unmapped };
}

/** The time of the newest event read so far; now for a feed that has never had one. */
function newestAt(raw: RestEvent[], position: FeedPosition): number {
  const times = raw.map((e) => Date.parse(e.created_at)).filter((at) => !Number.isNaN(at));
  const newest = Math.max(position.unknown ? Number.NEGATIVE_INFINITY : position.since, ...times);
  // An empty feed baselines at the current time so the first event after it is not lost.
  return Number.isFinite(newest) ? newest : Date.now();
}

function nextEntry(
  raw: RestEvent[],
  position: FeedPosition,
  etag: string | undefined,
): Cursor[string] {
  const stamp = newestAt(raw, position);
  const keep = position.unknown ? undefined : position.skip;
  const seen = raw
    .filter((e) => (keep ? keep.has(e.id) : true) && Date.parse(e.created_at) >= stamp - OVERLAP_MS)
    .map((e) => e.id);

  return {
    ...(etag ? { etag } : {}),
    since: new Date(stamp).toISOString(),
    ...(seen.length > 0 ? { seen } : {}),
  };
}

/** Polls one repository's event feed; undefined when it has not changed since the stored etag. */
export async function pollRepo(
  c: GithubContext,
  repo: RepoRef,
  position: FeedPosition,
): Promise<RepoPoll | undefined> {
  const token = await c.apiToken(repo);
  // A 304 answers without touching the rate limit.
  const first = await c.http.request<RestEvent[]>("GET", `${repoPath(repo)}/events`, {
    token,
    query: { per_page: 100 },
    ...(position.etag ? { headers: { "if-none-match": position.etag } } : {}),
  });

  if (first.status === 304) {
    return undefined;
  }

  const etag = first.headers.get("etag") ?? position.etag;
  const floor = feedFloor(position, first.data);
  const raw = await readOlderPages(c, token, first, floor);
  return { entry: nextEntry(raw, position, etag), ...collect(repo, raw, position, floor) };
}
