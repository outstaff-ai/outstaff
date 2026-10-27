import { mentionData, PortError, type DocEvent, type EventPage } from "@outstaff/core";
import { OVERLAP_MS, parseCursor, type Itsaplan } from "@outstaff/integration.tracker.itsaplan";
import { commentId } from "./comment-ids.js";
import type { ApiDoc, ApiDocComment } from "./types.js";

/** New comments on the given documents since `cursor`. */
export async function readDocEvents(
  deps: {
    api: Itsaplan;
    docs: string;
    idOf: (idOrPath: string) => Promise<number>;
    read: (id: number | string) => Promise<ApiDoc>;
    now: () => Date;
  },
  ids: string[],
  cursor: string | undefined,
): Promise<EventPage<DocEvent>> {
  const { api, docs, idOf, read, now } = deps;
  // Document comments are not in the project's activity feed, so the comments of each document are read.
  const after = parseCursor(cursor);
  const setup = await api.project();
  const all: { docId: number; comment: ApiDocComment; at: number }[] = [];
  for (const id of new Set(ids)) {
    const docId = await idOf(id);
    try {
      const found = await api.http.request<ApiDocComment[]>("GET", `${docs}/${docId}/comments`);

      for (const comment of found) {
        all.push({ docId, comment, at: Date.parse(comment.createdAt) });
      }
    } catch (error) {
      // A document that was deleted or closed to this account is no longer news; anything else is retried.
      if (!(error instanceof PortError) || !["not_found", "forbidden"].includes(error.code)) {
        throw error;
      }
    }
  }

  const key = (r: (typeof all)[number]) => commentId(r.docId, r.comment.id);
  const times = all.map((r) => r.at).filter((t) => !Number.isNaN(t));
  // Without a position, the window is what lies within the overlap of the newest comment.
  const floor = (after?.since ?? Math.max(...times)) - OVERLAP_MS;
  // No cursor at all is the first poll (the office decides if it is a baseline); a cursor we cannot use baselines here.
  const baseline = cursor !== undefined && !after;
  const fresh = baseline
    ? []
    : all.filter((r) => r.at >= floor && !(after?.seen.has(key(r)) ?? false));

  const titles = new Map<number, string>();
  const events: DocEvent[] = [];
  for (const r of fresh.toSorted((a, b) => a.at - b.at || key(a).localeCompare(key(b)))) {
    if (!titles.has(r.docId)) {
      titles.set(r.docId, (await read(r.docId)).title);
    }

    const c = r.comment;
    events.push({
      externalId: `itsaplan-doc:${key(r)}`,
      type: "commented",
      doc: String(r.docId),
      title: titles.get(r.docId)!,
      url: api.docUrl(String(r.docId)),
      actor: api.member(setup, c.authorId, c.authorName),
      at: c.createdAt,
      data: {
        commentId: key(r),
        ...(c.parentId ? { parentId: commentId(r.docId, c.parentId) } : {}),
        ...(c.quote ? { anchorText: c.quote } : {}),
        body: c.body,
        ...mentionData(c.body),
      },
    });
  }

  const newest = Math.max(after?.since ?? Number.NEGATIVE_INFINITY, ...times);
  const since = new Date(Number.isFinite(newest) ? newest : now().getTime()).toISOString();
  // Ids read at baseline time, kept while they are inside the overlap so that history is not handed back as news.
  const keep = after?.seen;
  const seen = all
    .filter((r) => (keep ? keep.has(key(r)) : true) && r.at >= Date.parse(since) - OVERLAP_MS)
    .map(key);

  return { events, cursor: JSON.stringify({ since, ...(seen.length > 0 ? { seen } : {}) }) };
}
