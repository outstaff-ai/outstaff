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
