import type { ApiDocIssue, ApiIssueDoc } from "@outstaff/integration.shared.itsaplan";
import type { StandInRequest } from "@outstaff/testing.http";
import { docById, issueById } from "./model.js";
import { err } from "./store.js";
import type { ActorRoute, ItsaplanStore, StoredDoc, StoredIssue } from "./types.js";

const asDocIssue = (issue: StoredIssue): ApiDocIssue => ({
  issueId: issue.id,
  sequenceNumber: issue.sequenceNumber,
  identifier: issue.identifier,
  title: issue.title,
  archived: false,
  createdAt: issue.createdAt,
});

const asIssueDoc = (d: StoredDoc): ApiIssueDoc => ({
  documentId: d.id,
  title: d.title,
  icon: null,
  isPrivate: false,
  archived: false,
  createdAt: d.createdAt,
});

const linksOf = (s: ItsaplanStore, docId: number) => s.docIssues.filter((l) => l.docId === docId);

/** The issues a document is linked on. */
function docIssues(s: ItsaplanStore, r: StandInRequest) {
  const doc = docById(s, r.params["id"]!);
  if (!doc) {
    return err(404, "document not found");
  }

  return linksOf(s, doc.id).map((l) => asDocIssue(issueById(s, String(l.issueId))!));
}

/** Links the document on an issue of the project, once: linking it again is a conflict. */
function link(s: ItsaplanStore, r: StandInRequest, actor: string) {
  const doc = docById(s, r.params["id"]!);
  const issue = issueById(s, String(r.json.issueId));
  if (!doc || !issue) {
    return err(404, doc ? "issue not found" : "document not found");
  }

  if (linksOf(s, doc.id).some((l) => l.issueId === issue.id)) {
    return err(409, "The document is already linked to this work item.", "conflict");
  }

  s.docIssues.push({ docId: doc.id, issueId: issue.id, by: actor });
  return { status: 201, body: asDocIssue(issue) };
}

/** Removes a link; one that does not exist is not found. */
function unlink(s: ItsaplanStore, r: StandInRequest) {
  const docId = Number(r.params["id"]);
  const issueId = Number(r.params["issueId"]);
  const at = s.docIssues.findIndex((l) => l.docId === docId && l.issueId === issueId);
  if (at < 0) {
    return err(404, "link not found");
  }

  s.docIssues.splice(at, 1);
  return { status: 204 };
}

/** The documents linked on an issue. */
function issueDocs(s: ItsaplanStore, r: StandInRequest) {
  const issue = issueById(s, r.params["issueId"]!);
  if (!issue) {
    return err(404, "issue not found");
  }

  return s.docIssues
    .filter((l) => l.issueId === issue.id)
    .map((l) => asIssueDoc(docById(s, String(l.docId))!));
}

/** Explicit links between documents and work items: list, link, unlink, and an issue's documents. */
export function docIssueRoutes(s: ItsaplanStore): ActorRoute[] {
  const path = "/projects/:p/documents/:id/issues";
  return [
    { method: "GET", path, handler: (r) => docIssues(s, r) },
    { method: "POST", path, handler: (r, actor) => link(s, r, actor) },
    { method: "DELETE", path: `${path}/:issueId`, handler: (r) => unlink(s, r) },
    {
      method: "GET",
      path: "/projects/:p/documents/for-issue/:issueId",
      handler: (r) => issueDocs(s, r),
    },
  ];
}
