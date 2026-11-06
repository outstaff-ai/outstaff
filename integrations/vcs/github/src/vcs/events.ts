import {
  PortError,
  type RepoRef,
  type UnmappedEvent,
  type UnreadRepo,
  type Vcs,
} from "@outstaff/core";
import type { Cursor } from "#/api.types.js";
import { directPosition, pollDirect } from "./direct-lists.js";
import { feedPosition, pollRepo } from "./event-feed.js";
import type { FeedPosition, FoundEvent, GithubContext, PollGet } from "./types.js";

function parseCursor(cursor: string | undefined): Cursor {
  if (!cursor) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(cursor);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Cursor;
    }
  } catch {
    // fall through
  }

  throw new PortError("invalid", "Unrecognised GitHub event cursor.");
}

/** Oldest first; events of the same time in id order. */
function byTimeThenId(a: FoundEvent, b: FoundEvent): number {
  if (a.at !== b.at) {
    return a.at - b.at;
  }

  return a.id < b.id ? -1 : Number(a.id > b.id);
}

/** The first of each external id: a comment or review read from both the feed and a direct list is one event. */
function once(found: FoundEvent[]): FoundEvent[] {
  const seen = new Set<string>();
  return found.filter((f) => !seen.has(f.event.externalId) && seen.add(f.event.externalId));
}

/** Where the direct lists start without a stored entry: at the feed's time, or now when the feed has none yet. */
function directStart(c: GithubContext, feed: FeedPosition): number {
  return feed.unknown ? c.now().getTime() : feed.since;
}

/** One repository: its feed, and the direct lists beside it, which a baseline does not read (they hold history). */
async function pollOne(
  c: GithubContext,
  get: PollGet,
  repo: RepoRef,
  state: Cursor,
  hasCursor: boolean,
) {
  const entry = state[`${repo.owner}/${repo.name}`];
  const feed = feedPosition(entry, hasCursor);
  const direct = directPosition(entry?.direct, directStart(c, feed));
  const poll = await pollRepo(c, get, repo, feed);
  const start = new Date(direct.since).toISOString();
  const lists = feed.unknown
    ? { cursor: { since: start, after: start }, found: [] }
    : await pollDirect(get, await c.apiToken(repo), repo, direct);

  return {
    entry: { ...(poll ? poll.entry : entry), direct: lists.cursor },
    found: [...(poll?.found ?? []), ...lists.found],
    unmapped: poll?.unmapped ?? [],
  };
}

/** A repository the office cannot read, such as one its App installation does not cover; not the host failing. */
const unreadable = (error: unknown): error is PortError =>
  error instanceof PortError && (error.code === "not_found" || error.code === "forbidden");

/** One repository's poll, or why it could not be read; a failure of the host itself is thrown. */
async function tryPollOne(...args: Parameters<typeof pollOne>) {
  try {
    return await pollOne(...args);
  } catch (error) {
    if (unreadable(error)) {
      return { error };
    }

    throw error;
  }
}

/**
 * The repository event feeds, polled by time with an etag per repository, and the direct comment and review lists
 * beside them, which do not lag.
 */
export function eventOperations(c: GithubContext): Pick<Vcs, "events"> {
  return {
    async events(repos, cursor) {
      const state = parseCursor(cursor);
      const next: Cursor = { ...state };
      const found: FoundEvent[] = [];
      const unmapped: UnmappedEvent[] = [];
      const unread: UnreadRepo[] = [];
      let requests = 0;
      const get: PollGet = (path, opts) => {
        requests++;
        return c.http.request("GET", path, opts);
      };

      for (const repo of repos) {
        const one = await tryPollOne(c, get, repo, state, cursor !== undefined);
        // An unread repository keeps its entry, so it reads on from there once it can be read.
        if ("error" in one) {
          unread.push({ repo, error: one.error });
          continue;
        }

        next[`${repo.owner}/${repo.name}`] = one.entry;
        found.push(...one.found);
        unmapped.push(...one.unmapped);
      }

      // Nothing could be read: that is the App's credentials or the host, not one repository, so the poll fails.
      if (unread.length > 0 && unread.length === repos.length) {
        throw unread[0]!.error;
      }

      c.log.debug(`vcs: GitHub poll of ${repos.length} repositories made ${requests} requests`, {
        repos: repos.length,
        requests,
      });

      found.sort(byTimeThenId);
      return {
        events: once(found).map((f) => f.event),
        cursor: JSON.stringify(next),
        unmapped,
        ...(unread.length > 0 ? { unread } : {}),
      };
    },
  };
}
