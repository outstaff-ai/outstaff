import { PortError } from "#/ports/index.js";
import type { RepoRef, VcsEvent, VcsEventPage } from "#/ports/index.js";
import type { EventLog } from "./util.js";

/** Where each repository was left off: `at` for all, `held` for those a poll left out before reaching `at`. */
interface Positions {
  at: string | undefined;
  held: Record<string, number>;
}

function parse(cursor: string | undefined): Positions {
  if (!cursor?.startsWith("{")) {
    return { at: cursor, held: {} };
  }

  try {
    const { at, held } = JSON.parse(cursor) as { at: number; held: Record<string, number> };
    return { at: String(at), held };
  } catch {
    throw new PortError("invalid", `Unknown cursor "${cursor}".`);
  }
}

/**
 * The new events of `repos`. A repository left out keeps its place: the cursor stays a plain count while every
 * repository is at it, and holds the place of each one that is behind.
 */
export function repoEvents(
  log: EventLog<VcsEvent>,
  key: (r: RepoRef) => string,
  repos: RepoRef[],
  cursor: string | undefined,
): VcsEventPage {
  const { at, held } = parse(cursor);
  const fresh = log.since(at);
  const all = log.since(undefined).events;
  const start = all.length - fresh.events.length;
  const from = (k: string) => held[k] ?? start;
  const wanted = new Set(repos.map(key));
  const events = all.filter((e, i) => wanted.has(key(e.repo)) && i >= from(key(e.repo)));
  const behind = Object.fromEntries(
    all
      .map((e) => key(e.repo))
      .filter((k) => !wanted.has(k) && from(k) < all.length)
      .map((k) => [k, from(k)]),
  );

  const next =
    Object.keys(behind).length === 0
      ? fresh.cursor
      : JSON.stringify({ at: all.length, held: behind });

  return { events, cursor: next };
}
