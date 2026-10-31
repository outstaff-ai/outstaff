import { columnOf, memberOf } from "./model.js";
import type { ItsaplanStore, StoredActivity, StoredIssue } from "./types.js";

const usernameOf = (s: ItsaplanStore, id: string | null) => (id ? memberOf(s, id).username : null);

const valueOf = (a: StoredActivity, side: "from" | "to") =>
  (a.payload[side] as { value?: string } | undefined)?.value;

/** One ticket as the test driver reads it. */
function ticketState(s: ItsaplanStore, i: StoredIssue) {
  const rows = s.activity.filter((a) => a.issueId === i.id);
  return {
    key: i.identifier,
    title: i.title,
    description: i.description,
    status: columnOf(s, i.columnId)?.name,
    assignee: usernameOf(s, i.assigneeUserId),
    parent: s.issues.find((p) => p.id === i.parentId)?.identifier ?? null,
    links: s.links.filter((l) => l.from === i.identifier),
    development: s.development
      .filter((l) => l.issueId === i.id)
      .map((l) => ({
        repository: s.repositories.find((r) => r.id === l.repositoryId)?.fullName,
        number: l.number,
        by: usernameOf(s, l.by),
      })),
    attachments: s.attachments
      .filter((a) => a.issueId === i.id)
      .map((a) => ({
        name: a.name,
        mimetype: a.mimetype,
        size: a.data.byteLength,
        base64: Buffer.from(a.data).toString("base64"),
      })),
    comments: rows
      .filter((a) => a.kind === "comment")
      .map((a) => ({ author: usernameOf(s, a.actorUserId), body: a.body })),
    moves: rows
      .filter((a) => a.action === "status")
      .map((a) => ({
        by: usernameOf(s, a.actorUserId),
        from: valueOf(a, "from"),
        to: valueOf(a, "to"),
      })),
  };
}

/** Every ticket, as the test driver checks them. */
export const ticketsState = (s: ItsaplanStore) => s.issues.map((i) => ticketState(s, i));

/** Every document with its comments, as the test driver checks them. */
export function docsState(s: ItsaplanStore) {
  return s.docs.map((d) => ({
    id: String(d.id),
    title: d.title,
    path: d.metadata["path"],
    body: d.content,
    version: d.version,
    comments: s.docComments
      .filter((c) => c.documentId === d.id)
      .map((c) => ({
        id: c.id,
        parentId: c.parentId,
        author: memberOf(s, c.authorId!).username,
        body: c.body,
        quote: c.quote,
        resolved: c.resolvedAt !== null,
      })),
  }));
}
