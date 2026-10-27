import type { Doc } from "@outstaff/core";
import type { KnowledgeSeed } from "@outstaff/core/contracts";
import { mdToDoc } from "../markdown.js";
import { findRange } from "../text-range.js";
import {
  createItsaplanFake as createTrackerFake,
  type FakeOptions,
} from "@outstaff/testing.itsaplan";
import type { ApiDoc, ApiDocSummary } from "@outstaff/integration.shared.itsaplan";
import type { ItsaplanFake, NewDocComment, StoredDoc, StoredDocComment } from "./types.js";

// The tracker package's stand-in for the Its a Plan REST API, plus the document routes the knowledge adapter uses.

/** Whether the comment's quote is in the document at exactly the positions it gives. */
function quotedAt(d: StoredDoc, b: NewDocComment): boolean {
  const range = d.contentJson && b.quote ? findRange(d.contentJson, b.quote) : undefined;
  return range !== undefined && range[0] === b.from && range[1] === b.to;
}

function storedComment(
  id: string,
  d: StoredDoc,
  b: NewDocComment,
  actor: { userId: string; name: string },
  at: string,
): StoredDocComment {
  return {
    id,
    documentId: d.id,
    parentId: b.parentId ?? null,
    authorId: actor.userId,
    authorName: actor.name,
    body: b.body,
    quote: b.quote ?? null,
    from: b.from ?? null,
    to: b.to ?? null,
    resolvedAt: null,
    createdAt: at,
  };
}

export function createItsaplanFake(opts: FakeOptions = {}): ItsaplanFake {
  let commentCounter = 0;
  const docs: StoredDoc[] = [];
  const docComments: StoredDocComment[] = [];
  let docId = 0;

  const docSummary = (d: StoredDoc): ApiDocSummary => {
    const { content: _c, contentJson: _j, ...rest } = d;
    return rest;
  };

  const docFull = (d: StoredDoc): ApiDoc => ({
    ...docSummary(d),
    content: d.content,
    contentJson: d.contentJson,
  });

  const doc = (id: string) => docs.find((d) => d.id === Number(id));

  const fake = createTrackerFake(opts, (shared) => {
    const { clock, err, actor } = shared;
    // A reply needs its parent; a new thread needs its quote at the positions it gives.
    const anchorRefusal = (d: StoredDoc, b: NewDocComment) => {
      if (b.parentId) {
        return docComments.some((c) => c.id === b.parentId)
          ? undefined
          : err(404, "comment not found");
      }

      return quotedAt(d, b) ? undefined : err(400, "The quote is not at those positions.");
    };

    return [
      {
        method: "GET",
        path: "/projects/:p/documents",
        handler: (r) => {
          const q = r.query.get("q")?.toLowerCase();
          return docs
            .filter((d) => (q ? `${d.title}\n${d.content}`.toLowerCase().includes(q) : true))
            .map(docSummary);
        },
      },
      {
        method: "POST",
        path: "/projects/:p/documents",
        handler: (r) => {
          const b = r.json as Partial<StoredDoc>;
          const row: StoredDoc = {
            id: ++docId,
            parentId: b.parentId ?? null,
            title: b.title ?? "Untitled",
            metadata: b.metadata ?? {},
            version: 1,
            content: b.content ?? "",
            contentJson: b.contentJson ?? null,
            createdAt: clock(),
            updatedAt: clock(),
          };

          docs.push(row);
          return { status: 201, body: docFull(row) };
        },
      },
      {
        method: "GET",
        path: "/projects/:p/documents/:id",
        handler: (r) => {
          if (r.params["id"] === "403") {
            return err(403, "You cannot read this document.", "forbidden");
          }

          const d = doc(r.params["id"]!);
          return d ? docFull(d) : err(404, "document not found");
        },
      },
      {
        method: "PATCH",
        path: "/projects/:p/documents/:id",
        handler: (r) => {
          const d = doc(r.params["id"]!);
          if (!d) {
            return err(404, "document not found");
          }

          const b = r.json as Partial<StoredDoc>;
          if (Number(b.version) !== d.version) {
            return err(409, "The page changed; read it again.", "version_conflict");
          }

          if (b.title !== undefined) {
            d.title = b.title;
          }

          if (b.content !== undefined) {
            d.content = b.content;
          }

          if (b.contentJson !== undefined) {
            d.contentJson = b.contentJson;
          }

          d.version += 1;
          d.updatedAt = clock();
          return docFull(d);
        },
      },
      {
        method: "GET",
        path: "/projects/:p/documents/:id/comments",
        handler: (r) => docComments.filter((c) => c.documentId === Number(r.params["id"])),
      },
      {
        method: "POST",
        path: "/projects/:p/documents/:id/comments",
        handler: (r) => {
          const d = doc(r.params["id"]!);
          if (!d) {
            return err(404, "document not found");
          }

          const b = r.json as NewDocComment;
          if (b.version !== d.version) {
            return err(409, "The page changed; read it again.", "version_conflict");
          }

          const refused = anchorRefusal(d, b);
          if (refused) {
            return refused;
          }

          const row = storedComment(`c-${++commentCounter}`, d, b, actor, clock());
          docComments.push(row);
          return { status: 201, body: { id: row.id } };
        },
      },
      {
        method: "PATCH",
        path: "/projects/:p/documents/:id/comments/:cid",
        handler: (r) => {
          const c = docComments.find(
            (x) => x.id === r.params["cid"] && x.documentId === Number(r.params["id"]),
          );

          if (!c) {
            return err(404, "comment not found");
          }

          if (r.json.resolved) {
            c.resolvedAt = clock();
          }

          return { ok: true };
        },
      },
    ];
  });

  const knowledgeSeed: KnowledgeSeed = {
    async doc(d) {
      const mdDoc = mdToDoc(d.body);
      const row: StoredDoc = {
        id: ++docId,
        parentId: null,
        title: d.title,
        metadata: { path: d.path },
        version: 1,
        content: d.body,
        contentJson: mdDoc,
        createdAt: fake.clock(),
        updatedAt: fake.clock(),
      };

      docs.push(row);
      return {
        id: String(row.id),
        path: d.path,
        title: d.title,
        body: d.body,
        url: "",
        version: "1",
        updatedAt: row.updatedAt,
      } satisfies Doc;
    },
  };

  return {
    ...fake,
    state: { ...fake.state, docs, docComments },
    knowledgeSeed,
  };
}
