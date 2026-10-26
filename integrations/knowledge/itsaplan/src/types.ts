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

export interface Tree {
  items: ApiDocSummary[];
  byId: Map<number, ApiDocSummary>;
}
