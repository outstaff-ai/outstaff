import type { ApiDoc, ApiDocSummary } from "@outstaff/integration.shared.itsaplan";
import type { StandInRequest } from "@outstaff/testing.http";
import { docById } from "./model.js";
import { err } from "./store.js";
import type { ActorRoute, ItsaplanStore, StoredDoc } from "./types.js";

const summaryOf = ({ content: _c, contentJson: _j, ...rest }: StoredDoc): ApiDocSummary => rest;

/** A page as a read, a create and a change serve it. */
export const docFull = (d: StoredDoc): ApiDoc & { ownerUserId: null; archivedAt: null } => ({
  ...d,
  ownerUserId: null,
  archivedAt: null,
});

function listDocs(s: ItsaplanStore, r: StandInRequest) {
  if (s.documents.listing === "all") {
    return s.docs.map(docFull);
  }

  const q = r.query.get("q")?.toLowerCase();
  return s.docs
    .filter((d) => (q ? `${d.title}\n${d.content}`.toLowerCase().includes(q) : true))
    .map(summaryOf);
}

function createDoc(s: ItsaplanStore, b: Partial<StoredDoc>) {
  const row: StoredDoc = {
    id: ++s.counters.doc,
    parentId: b.parentId ?? null,
    title: b.title ?? "Untitled",
    metadata: b.metadata ?? {},
    version: 1,
    content: b.content ?? "",
    contentJson: b.contentJson ?? null,
    createdAt: s.now(),
    updatedAt: s.now(),
  };

  s.docs.push(row);
  return { status: 201, body: docFull(row) };
}

/** A change must name the page's current version. */
function patchDoc(s: ItsaplanStore, d: StoredDoc, b: Partial<StoredDoc>) {
  if (Number(b.version) !== d.version) {
    return err(409, "The page changed; read it again.", "version_conflict");
  }

  for (const field of ["title", "content", "contentJson"] as const) {
    if (b[field] !== undefined) {
      Object.assign(d, { [field]: b[field] });
    }
  }

  d.version += 1;
  d.updatedAt = s.now();
  return docFull(d);
}

/** The project's documents: list (or search), create, read and change. */
export function documentRoutes(s: ItsaplanStore): ActorRoute[] {
  const missing = err(404, "document not found");
  return [
    { method: "GET", path: "/projects/:p/documents", handler: (r) => listDocs(s, r) },
    { method: "POST", path: "/projects/:p/documents", handler: (r) => createDoc(s, r.json) },
    {
      method: "GET",
      path: "/projects/:p/documents/:id",
      handler: (r) => {
        const d = docById(s, r.params["id"]!);
        return d ? docFull(d) : missing;
      },
    },
    {
      method: "PATCH",
      path: "/projects/:p/documents/:id",
      handler: (r) => {
        const d = docById(s, r.params["id"]!);
        return d ? patchDoc(s, d, r.json) : missing;
      },
    },
  ];
}
