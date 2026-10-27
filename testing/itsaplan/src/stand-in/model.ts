import type { Page } from "@outstaff/integration.shared.itsaplan";
import type {
  IssueInput,
  ItsaplanStore,
  StoredActivity,
  StoredDocComment,
  StoredIssue,
  StoredMember,
} from "./types.js";

export const memberOf = (s: ItsaplanStore, userId: string): StoredMember =>
  s.members.find((m) => m.userId === userId)!;

export const memberNamed = (s: ItsaplanStore, username: string): StoredMember | undefined =>
  s.members.find((m) => m.username === username);

export const columnOf = (s: ItsaplanStore, id: number) => s.columns.find((c) => c.id === id);

export const issueById = (s: ItsaplanStore, id: string) =>
  s.issues.find((i) => i.id === Number(id));

export const issueByKey = (s: ItsaplanStore, identifier: string) =>
  s.issues.find((i) => i.identifier === identifier);

export const docById = (s: ItsaplanStore, id: string) => s.docs.find((d) => d.id === Number(id));

export const touch = (s: ItsaplanStore, issue: StoredIssue) => void (issue.updatedAt = s.now());

/** Appends a row to the activity feed, as `actor`. */
export function log(
  s: ItsaplanStore,
  issue: StoredIssue,
  actor: string,
  entry: Pick<StoredActivity, "kind" | "action" | "body" | "payload">,
): StoredActivity {
  const row: StoredActivity = {
    id: ++s.counters.activity,
    issueId: issue.id,
    issueSequence: issue.sequenceNumber,
    issueTitle: issue.title,
    replyToId: null,
    actorUserId: actor,
    actorName: memberOf(s, actor).name,
    createdAt: s.now(),
    ...entry,
  };

  s.activity.push(row);
  return row;
}

export function createIssue(s: ItsaplanStore, actor: string, b: IssueInput): StoredIssue {
  const seq = s.issues.length + 1;
  const issue: StoredIssue = {
    id: 1000 + seq,
    sequenceNumber: seq,
    identifier: `${s.key}-${seq}`,
    title: b.title,
    description: b.description ?? "",
    columnId: b.columnId,
    assigneeUserId: b.assigneeUserId ?? null,
    labelIds: b.labelIds ?? [],
    parentId: b.parentId ?? null,
    createdAt: s.now(),
    updatedAt: s.now(),
  };

  s.issues.push(issue);
  log(s, issue, actor, { kind: "history", action: "created", body: null, payload: {} });
  return issue;
}

/** Moves an issue to another column; a move to its own column is no change. */
export function moveIssue(s: ItsaplanStore, issue: StoredIssue, actor: string, columnId: number) {
  if (columnId === issue.columnId) {
    return;
  }

  const from = columnOf(s, issue.columnId)?.name;
  issue.columnId = columnId;
  log(s, issue, actor, {
    kind: "history",
    action: "status",
    body: null,
    payload: { from: { value: from }, to: { value: columnOf(s, columnId)?.name } },
  });
}

export function assignIssue(
  s: ItsaplanStore,
  issue: StoredIssue,
  actor: string,
  userId: string | null,
) {
  issue.assigneeUserId = userId;
  log(s, issue, actor, { kind: "history", action: "assignee", body: null, payload: {} });
}

export function commentIssue(s: ItsaplanStore, issue: StoredIssue, actor: string, body: string) {
  touch(s, issue);
  return log(s, issue, actor, { kind: "comment", action: null, body, payload: {} });
}

/** A comment on a document, as `actor`. */
export function commentDoc(
  s: ItsaplanStore,
  actor: string,
  c: Pick<StoredDocComment, "documentId" | "parentId" | "body" | "quote" | "from" | "to">,
): StoredDocComment {
  const row: StoredDocComment = {
    id: `c-${++s.counters.comment}`,
    documentId: c.documentId,
    parentId: c.parentId,
    authorId: actor,
    authorName: memberOf(s, actor).name,
    body: c.body,
    quote: c.quote,
    from: c.from,
    to: c.to,
    resolvedAt: null,
    createdAt: s.now(),
  };

  s.docComments.push(row);
  return row;
}

/** One page of rows by id, with Its a Plan's `{ ts, id }` cursor. */
export function page<T extends { id: number; createdAt: string }>(
  all: T[],
  query: URLSearchParams,
  newestFirst: boolean,
): Page<T> {
  const limit = Math.min(Number(query.get("limit") ?? 25), 100);
  const raw = query.get("cursor");
  const cursor = raw ? (JSON.parse(raw) as { id: number }) : null;
  const sorted = all.toSorted((a, b) => (newestFirst ? b.id - a.id : a.id - b.id));
  const rows = cursor
    ? sorted.filter((r) => (newestFirst ? r.id < cursor.id : r.id > cursor.id))
    : sorted;

  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > limit && last ? { nextCursor: { ts: last.createdAt, id: last.id } } : {}),
  };
}
