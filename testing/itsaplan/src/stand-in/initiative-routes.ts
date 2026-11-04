import type { ApiInitiativeRef, ApiIssueDoc } from "@outstaff/integration.shared.itsaplan";
import type { StandInRequest } from "@outstaff/testing.http";
import { docById } from "./model.js";
import { err } from "./store.js";
import type { ActorRoute, ItsaplanStore, StoredInitiative, StoredIssue } from "./types.js";

const STATUSES = new Set(["proposed", "planned", "active", "completed", "canceled"]);

const initiativeById = (s: ItsaplanStore, id: unknown) =>
  s.initiatives.find((i) => i.id === Number(id));

/** The initiative an issue is in, as reading the issue names it; null when it is in none. */
export function initiativeOf(s: ItsaplanStore, issue: StoredIssue): ApiInitiativeRef | null {
  const found = issue.initiativeId === null ? undefined : initiativeById(s, issue.initiativeId);
  return found ? { id: found.id, title: found.title, status: found.status } : null;
}

/** The issue as reading, creating or changing it answers: with its initiative named, not its id. */
export function withInitiative(s: ItsaplanStore, issue: StoredIssue) {
  const { initiativeId: _, ...rest } = issue;
  return { ...rest, initiative: initiativeOf(s, issue) };
}

/** Whether a body's `initiativeId` names an initiative of the project, or nothing (null unlinks). */
export const knownInitiative = (s: ItsaplanStore, id: unknown) =>
  id === undefined || id === null || initiativeById(s, id) !== undefined;

const missing = err(404, "initiative not found");

/** Applies a create or change body; a status the API does not know is refused. */
function apply(s: ItsaplanStore, i: StoredInitiative, b: Record<string, unknown>) {
  if (b["status"] !== undefined && !STATUSES.has(String(b["status"]))) {
    return err(400, "unknown status");
  }

  for (const field of ["title", "description", "status"] as const) {
    if (typeof b[field] === "string") {
      i[field] = b[field];
    }
  }

  i.updatedAt = s.now();
  return i;
}

function create(s: ItsaplanStore, r: StandInRequest) {
  const title = r.json.title;
  if (typeof title !== "string" || title.trim() === "") {
    return err(400, "title is required");
  }

  const at = s.now();
  const made: StoredInitiative = {
    id: 300 + s.initiatives.length + 1,
    projectId: 1,
    title,
    description: "",
    status: "planned",
    createdAt: at,
    updatedAt: at,
  };

  const applied = apply(s, made, r.json);
  if (applied !== made) {
    return applied;
  }

  s.initiatives.push(made);
  return { status: 201, body: made };
}

function list(s: ItsaplanStore, r: StandInRequest) {
  const wanted = (r.query.get("status") ?? "").split(",").filter(Boolean);
  const items = s.initiatives.filter((i) => wanted.length === 0 || wanted.includes(i.status));
  return { items, total: items.length, page: 1, pageSize: Math.max(items.length, 25) };
}

const asDoc = (s: ItsaplanStore, docId: number): ApiIssueDoc => {
  const d = docById(s, String(docId))!;
  return {
    documentId: d.id,
    title: d.title,
    icon: null,
    isPrivate: false,
    archived: false,
    createdAt: d.createdAt,
  };
};

/** Links a document to an initiative, once: linking it again is a conflict. */
function linkDoc(s: ItsaplanStore, r: StandInRequest, actor: string) {
  const doc = docById(s, r.params["id"]!);
  const initiative = initiativeById(s, r.json.initiativeId);
  if (!doc || !initiative) {
    return err(404, doc ? "initiative not found" : "document not found");
  }

  const linked = (l: ItsaplanStore["docInitiatives"][number]) =>
    l.docId === doc.id && l.initiativeId === initiative.id;

  if (s.docInitiatives.some(linked)) {
    return err(409, "The document is already linked to this initiative.", "conflict");
  }

  s.docInitiatives.push({ docId: doc.id, initiativeId: initiative.id, by: actor });
  return { status: 201, body: asDoc(s, doc.id) };
}

function initiativeDocs(s: ItsaplanStore, r: StandInRequest) {
  const initiative = initiativeById(s, r.params["initiativeId"]);
  return initiative
    ? s.docInitiatives.filter((l) => l.initiativeId === initiative.id).map((l) => asDoc(s, l.docId))
    : missing;
}

/** The project's initiatives: list, create, read and change; and the documents linked to one. */
export function initiativeRoutes(s: ItsaplanStore): ActorRoute[] {
  return [
    { method: "GET", path: "/projects/:p/initiatives", handler: (r) => list(s, r) },
    { method: "POST", path: "/projects/:p/initiatives", handler: (r) => create(s, r) },
    {
      method: "GET",
      path: "/initiatives/:id",
      handler: (r) => initiativeById(s, r.params["id"]) ?? missing,
    },
    {
      method: "PATCH",
      path: "/initiatives/:id",
      handler: (r) => {
        const found = initiativeById(s, r.params["id"]);
        return found ? apply(s, found, r.json) : missing;
      },
    },
    {
      method: "POST",
      path: "/projects/:p/documents/:id/initiatives",
      handler: (r, actor) => linkDoc(s, r, actor),
    },
    {
      method: "GET",
      path: "/projects/:p/documents/for-initiative/:initiativeId",
      handler: (r) => initiativeDocs(s, r),
    },
  ];
}
