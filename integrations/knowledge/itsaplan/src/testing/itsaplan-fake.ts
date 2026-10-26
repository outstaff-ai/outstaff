import type { Doc } from "@outstaff/core";
import type { KnowledgeSeed } from "@outstaff/core/contracts";
import { findRange, mdToDoc, type PmNode } from "../markdown.js";
import {
  createItsaplanFake as createTrackerFake,
  type FakeOptions,
  type ItsaplanFake as TrackerFake,
} from "../../../../tracker/itsaplan/src/testing/itsaplan-fake.js";

// The tracker package's stand-in for the Its a Plan REST API, plus the document routes the knowledge adapter uses.

interface DocRow {
  id: number;
  parentId: number | null;
  title: string;
  metadata: Record<string, unknown>;
  version: number;
  content: string;
  contentJson: PmNode | null;
  createdAt: string;
  updatedAt: string;
}

interface DocComment {
  id: string;
  documentId: number;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  quote: string | null;
  from: number | null;
  to: number | null;
  resolvedAt: string | null;
  createdAt: string;
}

export type ItsaplanFake = TrackerFake & {
  state: TrackerFake["state"] & { docs: DocRow[]; docComments: DocComment[] };
  knowledgeSeed: KnowledgeSeed;
};

export function createItsaplanFake(opts: FakeOptions = {}): ItsaplanFake {
  let commentCounter = 0;
  const docs: DocRow[] = [];
  const docComments: DocComment[] = [];
  let docId = 0;

  const docSummary = (d: DocRow) => {
    const { content: _c, contentJson: _j, ...rest } = d;
    return rest;
  };

  const docFull = (d: DocRow) => ({
    ...docSummary(d),
    content: d.content,
    contentJson: d.contentJson,
  });

  const doc = (id: string) => docs.find((d) => d.id === Number(id));

  const fake = createTrackerFake(opts, (shared) => {
    const { clock, err, actor } = shared;
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
          const b = r.json as Partial<DocRow>;
          const row: DocRow = {
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

          const b = r.json as Partial<DocRow>;
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

          const b = r.json as {
            body: string;
            parentId?: string;
            quote?: string;
            from?: number;
            to?: number;
            version: number;
          };

          if (b.version !== d.version) {
            return err(409, "The page changed; read it again.", "version_conflict");
          }

          if (!b.parentId) {
            const range = d.contentJson && b.quote ? findRange(d.contentJson, b.quote) : undefined;
            if (!range || range[0] !== b.from || range[1] !== b.to) {
              return err(400, "The quote is not at those positions.");
            }
          } else if (!docComments.some((c) => c.id === b.parentId)) {
            return err(404, "comment not found");
          }

          const row: DocComment = {
            id: `c-${++commentCounter}`,
            documentId: d.id,
            parentId: b.parentId ?? null,
            authorId: actor.userId,
            authorName: actor.name,
            body: b.body,
            quote: b.quote ?? null,
            from: b.from ?? null,
            to: b.to ?? null,
            resolvedAt: null,
            createdAt: clock(),
          };

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
      const row: DocRow = {
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
