import { PortError, type UnmappedEvent, type Vcs, type VcsEvent } from "@outstaff/core";
import { nextLink } from "../http.js";
import { toVcsEvent } from "../mapping.js";
import type { Cursor, RestEvent } from "../api.types.js";
import { repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

const EVENT_PAGES = 3;
// Re-read this much before the newest time seen; intake de-duplicates by external id.
const OVERLAP_MS = 5 * 60_000;

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

/** The repository event feeds, polled by time with an etag per repository. */
export function eventOperations(c: GithubContext): Pick<Vcs, "events"> {
  const { http, apiUrl, apiToken } = c;
  return {
    async events(repos, cursor) {
      const state = parseCursor(cursor);
      const next: Cursor = { ...state };
      const found: { event: VcsEvent; at: number; id: bigint }[] = [];
      const unmapped: UnmappedEvent[] = [];
      for (const repo of repos) {
        const key = `${repo.owner}/${repo.name}`;
        const prev = state[key];
        // An entry without a valid `since` (new repo, or a cursor from before times were tracked) is no entry.
        const since = prev && typeof prev.since === "string" ? Date.parse(prev.since) : Number.NaN;
        const unknown = Number.isNaN(since);
        // No cursor at all is the first poll: intake decides whether that history is a baseline.
        // A cursor that lacks this repository only baselines this repository (#229).
        const baseline = unknown && cursor !== undefined;
        const token = await apiToken(repo);
        // A 304 answers without touching the rate limit.
        let res = await http.request<RestEvent[]>("GET", `${repoPath(repo)}/events`, {
          token,
          query: { per_page: 100 },
          ...(!unknown && prev?.etag ? { headers: { "if-none-match": prev.etag } } : {}),
        });

        if (res.status === 304) {
          continue;
        }

        const etag = res.headers.get("etag") ?? (unknown ? undefined : prev?.etag);
        const raw: RestEvent[] = [...res.data];
        // GitHub event ids are not one sequence and the feed is only roughly time-ordered, so page by time.
        let floor = since - OVERLAP_MS;
        if (unknown) {
          floor = Math.max(...res.data.map((e) => Date.parse(e.created_at))) - OVERLAP_MS;
        }

        for (let page = 1; page < EVENT_PAGES; page++) {
          const link = nextLink(res.headers.get("link"), apiUrl);
          const oldest = res.data.at(-1);
          if (!link || !oldest || Date.parse(oldest.created_at) < floor) {
            break;
          }

          res = await http.request<RestEvent[]>("GET", link, { token });
          raw.push(...res.data);
        }

        // Ids already read at baseline time: the overlap would otherwise hand that history back as news.
        const skip = new Set(unknown ? [] : prev?.seen);
        let newest = unknown ? Number.NEGATIVE_INFINITY : since;
        for (const e of raw) {
          const at = Date.parse(e.created_at);
          if (!Number.isNaN(at) && at > newest) {
            newest = at;
          }

          if (baseline || Number.isNaN(at) || at < floor || skip.has(e.id)) {
            continue;
          }

          const event = toVcsEvent(repo, e);
          if (event) {
            found.push({ event, at, id: BigInt(e.id) });
          } else {
            const action = e.payload["action"];
            unmapped.push({
              externalId: e.id,
              type: typeof action === "string" ? `${e.type} (${action})` : e.type,
              repo,
            });
          }
        }

        // An empty feed baselines at the current time so the first event after it is not lost.
        const stamp = Number.isFinite(newest) ? newest : Date.now();
        const keep = unknown ? undefined : skip;
        const seen = raw
          .filter(
            (e) => (keep ? keep.has(e.id) : true) && Date.parse(e.created_at) >= stamp - OVERLAP_MS,
          )
          .map((e) => e.id);

        next[key] = {
          ...(etag ? { etag } : {}),
          since: new Date(stamp).toISOString(),
          ...(seen.length > 0 ? { seen } : {}),
        };
      }

      found.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { events: found.map((f) => f.event), cursor: JSON.stringify(next), unmapped };
    },
  };
}
