import { mentionData, PortError, type DocEvent, type EventPage, type Member } from "@outstaff/core";
import {
  nextCursor,
  OVERLAP_MS,
  parseCursor,
  type Itsaplan,
} from "@outstaff/integration.tracker.itsaplan";
import { commentId } from "./comment-ids.js";
import type { ApiDocComment, DocEventDeps, ReadComment } from "./types.js";

/** A document that was deleted or closed to this account is no longer news; anything else is retried. */
const isGone = (error: unknown) =>
  error instanceof PortError && ["not_found", "forbidden"].includes(error.code);

async function commentsOf(api: Itsaplan, docs: string, docId: number): Promise<ReadComment[]> {
  try {
    const found = await api.http.request<ApiDocComment[]>("GET", `${docs}/${docId}/comments`);
    return found.map((comment) => ({ docId, comment, at: Date.parse(comment.createdAt) }));
  } catch (error) {
    if (!isGone(error)) {
      throw error;
    }

    return [];
  }
}

// Document comments are not in the project's activity feed, so the comments of each document are read.
async function readComments(deps: DocEventDeps, ids: string[]): Promise<ReadComment[]> {
  const all: ReadComment[] = [];
  for (const id of new Set(ids)) {
    all.push(...(await commentsOf(deps.api, deps.docs, await deps.idOf(id))));
  }

  return all;
}

const key = (r: ReadComment) => commentId(r.docId, r.comment.id);

function toEvent(api: Itsaplan, member: Member, r: ReadComment, title: string): DocEvent {
  const c = r.comment;
  return {
    externalId: `itsaplan-doc:${key(r)}`,
    type: "commented",
    doc: String(r.docId),
    title,
    url: api.docUrl(String(r.docId)),
    actor: member,
    at: c.createdAt,
    data: {
      commentId: key(r),
      ...(c.parentId ? { parentId: commentId(r.docId, c.parentId) } : {}),
      ...(c.quote ? { anchorText: c.quote } : {}),
      body: c.body,
      ...mentionData(c.body),
    },
  };
}

/** New comments on the given documents since `cursor`. */
export async function readDocEvents(
  deps: DocEventDeps,
  ids: string[],
  cursor: string | undefined,
): Promise<EventPage<DocEvent>> {
  const { api, read, now } = deps;
  const after = parseCursor(cursor);
  const setup = await api.project();
  const all = await readComments(deps, ids);
  const times = all.map((r) => r.at).filter((t) => !Number.isNaN(t));
  // Without a position, the window is what lies within the overlap of the newest comment.
  const floor = (after?.since ?? Math.max(...times)) - OVERLAP_MS;
  // No cursor at all is the first poll (the office decides if it is a baseline); a cursor we cannot use baselines here.
  const baseline = cursor !== undefined && !after;
  const isNew = (r: ReadComment) => r.at >= floor && !(after?.seen.has(key(r)) ?? false);
  const fresh = baseline ? [] : all.filter(isNew);

  const titles = new Map<number, string>();
  const events: DocEvent[] = [];
  for (const r of fresh.toSorted((a, b) => a.at - b.at || key(a).localeCompare(key(b)))) {
    if (!titles.has(r.docId)) {
      titles.set(r.docId, (await read(r.docId)).title);
    }

    const member = api.member(setup, r.comment.authorId, r.comment.authorName);
    events.push(toEvent(api, member, r, titles.get(r.docId)!));
  }

  const seen = all.map((r) => ({ id: key(r), at: r.at }));
  return { events, cursor: nextCursor(after, seen, () => now().getTime()) };
}
