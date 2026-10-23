import type { Links } from "./links.js";

export interface Doc {
  id: string;
  path: string;
  title: string;
  body: string;
  url: string;

  /** Opaque; pass back as `baseVersion` to detect concurrent edits. */
  version: string;
  updatedAt: string;
}

export interface DocComment {
  id: string;
  docId: string;
  author: string;
  body: string;
  anchorText?: string;
  parentId?: string;
  resolved: boolean;
  at: string;
}

export interface Knowledge {
  links: Pick<Links, "doc">;
  search(query: string, limit?: number): Promise<Doc[]>;
  get(idOrPath: string): Promise<Doc>;
  create(doc: { path: string; title: string; body: string }): Promise<Doc>;

  /** Rejects with `conflict` when `baseVersion` is stale. */
  update(id: string, patch: { title?: string; body?: string; baseVersion?: string }): Promise<Doc>;
  comments(id: string): Promise<DocComment[]>;
  comment(id: string, comment: { body: string; anchorText?: string }): Promise<DocComment>;
  reply(commentId: string, body: string): Promise<DocComment>;
  resolve(commentId: string): Promise<void>;
}
