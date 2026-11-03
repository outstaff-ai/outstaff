// The API's shapes, as far as the adapters read them.

export interface ApiColumn {
  id: number;
  name: string;
  stateType: string;
  position?: number;
  projectId?: number;
}

export interface ApiLabel {
  id: number;
  name: string;
  projectId?: number;
}

export interface ApiAssignee {
  userId: string;
  name: string;
  username?: string | null;
  kind?: "member" | "agent";
}

export interface ApiProject {
  project: {
    id: number;
    key: string;
    ref: string;
    name: string;
    teamRef?: string;
    teamId?: number;
    teamName?: string;
  };
  columns: ApiColumn[];
  labels: ApiLabel[];
  assignees: ApiAssignee[];
}

export interface ApiIssue {
  id: number;
  sequenceNumber: number;
  identifier: string;
  title: string;
  description?: string | null;
  columnId: number;
  assigneeUserId?: string | null;
  labelIds?: number[];
  parentId?: number | null;
  createdAt?: string;
  updatedAt: string;

  /** The initiative it is in, by id; a listing carries it, reading one issue gives `initiative` instead. */
  initiativeId?: number | null;

  /** The initiative it is in; reading, creating or changing one issue carries it, a listing does not. */
  initiative?: ApiInitiativeRef | null;

  /** The issue's relations to other issues; only reading one issue carries them. */
  links?: ApiIssueLink[];

  /** The issue's custom field values; reading one issue carries them. */
  fieldValues?: ApiFieldValue[];
}

/** A project's custom field. A field of no issue type (`issueTypeId` null) is on every issue. */
export interface ApiCustomField {
  id: number;
  issueTypeId: number | null;
  name: string;
  fieldType: string;
  memberScope?: string | null;
  showInBody?: boolean;
  position?: number;
  options?: { id: number; value: string; color: string; position: number }[];
}

/** One custom field's value on an issue. */
export interface ApiFieldValue {
  fieldId: number;
  value: string | number | boolean | null;
  valueEnd?: string | null;
  optionIds?: number[];
}

/**
 * A relation of an issue to another, as read from the issue: `outward` is the relation as stated (this issue blocks
 * the other), `inward` the other way round (this issue is blocked by the other).
 */
export interface ApiIssueLink {
  id: number;
  kind: "blocks" | "relates" | "duplicates";
  direction: "outward" | "inward";
  issue: Pick<ApiIssue, "id" | "sequenceNumber" | "identifier" | "title" | "columnId">;
}

/** The API names these fields in more than one way across versions; the first present one wins. */
export interface ApiAttachment {
  publicId?: string;
  id?: string | number;
  filename?: string;
  name?: string;
  mimeType?: string;
  contentType?: string;
  size?: number;
}

export interface ApiFeedItem {
  id: number;
  kind: string;
  replyToId?: number | null;
  actorUserId?: string | null;
  actorName?: string | null;
  body?: string | null;
  createdAt: string;
}

export interface ApiActivityItem extends ApiFeedItem {
  issueId: number;
  issueSequence: number;
  issueTitle?: string;
  action?: string | null;
  payload?: {
    from?: { value?: string | undefined };
    to?: { value?: string | undefined };
    subject?: { value?: string };
  };
}

export interface Page<T> {
  items: T[];
  nextCursor?: { ts: string; id: number } | null;
}

// Documents: ProseMirror content as the editor stores it.

export interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  marks?: Mark[];
  text?: string;
}

export interface ApiDocSummary {
  id: number;
  parentId?: number | null;
  title: string;
  metadata?: { path?: string } | null;
  version: number;

  /** A private page is visible to its owner only. */
  isPrivate?: boolean;
  ownerUserId?: string | null;
  createdByUserId?: string | null;

  /** Who wrote the current version. */
  updatedByUserId?: string | null;
  createdAt?: string;
  updatedAt: string;
}

export interface ApiDoc extends ApiDocSummary {
  content?: string | null;
  contentJson?: PmNode | null;
}

/** One saved version of a page, as `GET /projects/{key}/documents/{id}/revisions` lists it. */
export interface ApiDocRevision {
  id: number;
  documentId: number;
  version: number;
  title: string;

  /** Who wrote this version. */
  createdByUserId: string | null;
  createdAt: string;
}

/** A revision with its text, as `GET /projects/{key}/documents/{id}/revisions/{revisionId}` answers. */
export interface ApiDocRevisionContent extends ApiDocRevision {
  content: string;
}

export interface ApiDocComment {
  id: string;
  documentId?: number;
  parentId?: string | null;
  authorId?: string | null;
  authorName?: string | null;
  body: string;
  quote?: string | null;
  from?: number | null;
  to?: number | null;
  resolvedAt?: string | null;
  createdAt: string;
}

// Development: the code repositories connected to the team, and the pull requests linked on an issue.

export interface ApiDevRepository {
  id: number;
  provider: "github" | "gitlab";

  /** `owner/name`. */
  fullName: string;
  webUrl: string;
}

export interface ApiDevPullRequest {
  number: number;
  title: string;
  url: string | null;
  state: "open" | "merged" | "closed";
  draft: boolean;
  sourceBranch: string | null;
  targetBranch: string;
  headSha: string | null;
  updatedAt: string;

  /** Whether it is linked on the issue the listing was asked for. */
  linked: boolean;
}

export interface ApiDevPullRequestPage {
  pullRequests: ApiDevPullRequest[];
  nextPage: number | null;
}

/** A pull request linked on an issue, as `POST /issues/{id}/development` answers. */
export interface ApiDevLink {
  id: number;
  provider: string;
  repository: string;
  kind: "pull_request" | "branch";
  number: number | null;
  title: string;
  url: string | null;
}

// Documents linked on issues.

/** An issue a document is linked on, as `GET` and `POST /projects/{key}/documents/{id}/issues` answer. */
export interface ApiDocIssue {
  issueId: number;
  sequenceNumber: number;
  identifier: string;
  title: string;
  archived: boolean;
  createdAt: string;
}

/** A document linked on an issue, as `GET /projects/{key}/documents/for-issue/{issueId}` answers. */
export interface ApiIssueDoc {
  documentId: number;
  title: string;
  icon: string | null;
  isPrivate: boolean;
  archived: boolean;
  createdAt: string;
}

/** An initiative as an issue names it. */
export interface ApiInitiativeRef {
  id: number;
  title: string;
  status: string;
}

/** An initiative of the project: `proposed`, `planned`, `active`, `completed` or `canceled`. */
export interface ApiInitiative extends ApiInitiativeRef {
  projectId: number;
  description: string;
  updatedAt: string;
}

/** A page of `GET /projects/{key}/initiatives`. */
export interface ApiInitiativePage {
  items: ApiInitiative[];
  total: number;
  page: number;
  pageSize: number;
}
