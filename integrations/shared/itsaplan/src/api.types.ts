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
  createdAt?: string;
  updatedAt: string;
}

export interface ApiDoc extends ApiDocSummary {
  content?: string | null;
  contentJson?: PmNode | null;
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
