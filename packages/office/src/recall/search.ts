import type { PayloadOf } from "@outstaff/protocol";
import { ProtocolError } from "#/protocol/errors.js";
import type { Recall } from "#/protocol/source.types.js";
import type { Moment, MomentRef } from "#/store/types.js";
import { aboutRefs } from "./about.js";
import { excerpt } from "./excerpt.js";
import type { RecallOptions } from "./types.js";
import { people } from "./who.js";

type Result = PayloadOf<"recall_result">["moments"][number];
type Where = NonNullable<Result["where"]>;

/** The time `--since` names, as the store compares it; refused when it is not a date. */
function sinceOf(since: string | undefined): string | undefined {
  if (since === undefined) {
    return undefined;
  }

  const at = new Date(since);
  if (Number.isNaN(at.getTime())) {
    throw new ProtocolError(
      "invalid",
      `--since ${since} is not a date; use 2026-10-01 or an ISO time.`,
    );
  }

  return at.toISOString();
}

/** What the office keeps of a ticket, pull request or document: its title and link. */
interface Kept {
  title?: string;
  url?: string;
}

/** Answers `recall`: the caller's moments that match, newest first, each with where, who, an excerpt and a link. */
export function createRecallSearch(opts: RecallOptions): Recall {
  const { store, team, workState, tracker } = opts;
  const known = people(team);

  /** Where a moment happened, with the title and link the office knows; read once per search. */
  const whereOf = (cache: Map<string, Promise<Where>>, ref: MomentRef): Promise<Where> => {
    const key = `${ref.type}:${ref.ref}`;
    let found = cache.get(key);
    if (!found) {
      found = store.getSubject(ref.type, ref.ref).then((s) => {
        const rec = (s?.data ?? {}) as Kept;
        const url = rec.url ?? (ref.type === "ticket" ? tracker?.links.issue(ref.ref) : undefined);

        return {
          type: ref.type,
          ref: ref.ref,
          ...(rec.title ? { title: rec.title } : {}),
          ...(url ? { url } : {}),
        };
      });

      cache.set(key, found);
    }

    return found;
  };

  const toResult = async (m: Moment, query: string, cache: Map<string, Promise<Where>>) => {
    const where = m.subject ? await whereOf(cache, m.subject) : undefined;
    const who = known.shown(m.actor, m.actorName);
    const url = m.url ?? where?.url;
    return {
      at: m.at,
      kind: m.kind,
      ...(where ? { where } : {}),
      ...(who ? { who } : {}),
      excerpt: excerpt(m.text, query),
      ...(url ? { url } : {}),
    } satisfies Result;
  };

  return {
    async search(person, request) {
      const found = await store.searchMoments({
        person,
        text: request.query,
        ...(request.with ? { with: known.namesOf(request.with) } : {}),
        ...(request.about ? { about: aboutRefs(workState, team, request.about) } : {}),
        since: sinceOf(request.since),
        limit: request.limit + 1,
      });

      const cache = new Map<string, Promise<Where>>();
      const moments = await Promise.all(
        found.slice(0, request.limit).map((m) => toResult(m, request.query, cache)),
      );

      return { moments, more: found.length > request.limit };
    },
  };
}
