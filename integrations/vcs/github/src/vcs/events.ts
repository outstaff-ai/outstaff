import { PortError, type UnmappedEvent, type Vcs } from "@outstaff/core";
import type { Cursor } from "../api.types.js";
import { feedPosition, pollRepo } from "./event-feed.js";
import type { FoundEvent, GithubContext } from "./types.js";

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

/** The repository event feeds, polled by time with an etag per repository. */
export function eventOperations(c: GithubContext): Pick<Vcs, "events"> {
  return {
    async events(repos, cursor) {
      const state = parseCursor(cursor);
      const next: Cursor = { ...state };
      const found: FoundEvent[] = [];
      const unmapped: UnmappedEvent[] = [];
      for (const repo of repos) {
        const key = `${repo.owner}/${repo.name}`;
        const poll = await pollRepo(c, repo, feedPosition(state[key], cursor !== undefined));
        if (poll) {
          next[key] = poll.entry;
          found.push(...poll.found);
          unmapped.push(...poll.unmapped);
        }
      }

      found.sort(byTimeThenId);
      return { events: found.map((f) => f.event), cursor: JSON.stringify(next), unmapped };
    },
  };
}
