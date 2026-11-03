import type { ApiDoc, ApiDocRevision, ApiDocSummary } from "@outstaff/integration.shared.itsaplan";
import type { StandInRequest } from "@outstaff/testing.http";
import { addDoc, changeDoc } from "./doc-model.js";
import { docById } from "./model.js";
import { err } from "./store.js";
import type { ActorRoute, ItsaplanStore, StoredDoc, StoredDocRevision } from "./types.js";

const summaryOf = ({ content: _c, contentJson: _j, ...rest }: StoredDoc): ApiDocSummary => rest;

/** A page as a read, a create and a change serve it. */
export const docFull = (d: StoredDoc): ApiDoc & { archivedAt: null } => ({
  ...d,
  archivedAt: null,
});

const revisionOf = ({ content: _c, ...rest }: StoredDocRevision): ApiDocRevision => rest;

/** A private page is listed and served to its owner only. */
const visible = (d: StoredDoc, actor: string) => !d.isPrivate || d.ownerUserId === actor;

function listDocs(s: ItsaplanStore, r: StandInRequest, actor: string) {
  const mine = s.docs.filter((d) => visible(d, actor));
  if (s.documents.listing === "all") {
    return mine.map(docFull);
  }

  const q = r.query.get("q")?.toLowerCase();
  return mine
    .filter((d) => (q ? `${d.title}\n${d.content}`.toLowerCase().includes(q) : true))
    .map(summaryOf);
}

/** A change must name the page's current version. */
function patchDoc(s: ItsaplanStore, d: StoredDoc, b: Partial<StoredDoc>, actor: string) {
  if (Number(b.version) !== d.version) {
    return err(409, "The page changed; read it again.", "version_conflict");
  }

  return docFull(changeDoc(s, d, b, actor));
}

/** The page by the route's id, as `actor` may see it. */
const pageFor = (s: ItsaplanStore, r: StandInRequest, actor: string) => {
  const d = docById(s, r.params["id"]!);
  return d && visible(d, actor) ? d : undefined;
};

/** Saved versions of a page, newest first, and one of them with its text. */
function revisionRoutes(s: ItsaplanStore): ActorRoute[] {
  const missing = err(404, "document not found");
  const of = (d: StoredDoc) =>
    s.docRevisions.filter((v) => v.documentId === d.id).toSorted((a, b) => b.version - a.version);

  return [
    {
      method: "GET",
      path: "/projects/:p/documents/:id/revisions",
      handler: (r, actor) => {
        const d = pageFor(s, r, actor);
        return d ? of(d).map(revisionOf) : missing;
      },
    },
    {
      method: "GET",
      path: "/projects/:p/documents/:id/revisions/:rid",
      handler: (r, actor) => {
        const d = pageFor(s, r, actor);
        const v = d && of(d).find((x) => x.id === Number(r.params["rid"]));
        return v ?? err(404, "revision not found");
      },
    },
  ];
}

/** The project's documents: list (or search), create, read and change, and their revisions. */
export function documentRoutes(s: ItsaplanStore): ActorRoute[] {
  const missing = err(404, "document not found");
  return [
    { method: "GET", path: "/projects/:p/documents", handler: (r, a) => listDocs(s, r, a) },
    {
      method: "POST",
      path: "/projects/:p/documents",
      handler: (r, actor) => ({ status: 201, body: docFull(addDoc(s, r.json, actor)) }),
    },
    {
      method: "GET",
      path: "/projects/:p/documents/:id",
      handler: (r, actor) => {
        const d = pageFor(s, r, actor);
        return d ? docFull(d) : missing;
      },
    },
    {
      method: "PATCH",
      path: "/projects/:p/documents/:id",
      handler: (r, actor) => {
        const d = pageFor(s, r, actor);
        return d ? patchDoc(s, d, r.json, actor) : missing;
      },
    },
    ...revisionRoutes(s),
  ];
}
