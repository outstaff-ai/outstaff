import type { EventPage } from "./events.js";
import type { Links } from "./links.js";
import type { Member } from "./tracker.js";

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

/** A comment or reply written on a document; the event feed of a knowledge base. */
export interface DocEvent {
  /** Stable across polls: the office de-duplicates by it. */
  externalId: string;
  type: "commented";

  /** Id of the document. */
  doc: string;
  title: string;
  url: string;
  actor: Member;
  at: string;
  data: {
    commentId: string;
    parentId?: string;

    /** The text of the document the comment is anchored to. */
    anchorText?: string;
    body: string;
  };
}

export interface Knowledge {
  links: Pick<Links, "doc" | "comment">;
  search(query: string, limit?: number): Promise<Doc[]>;
  get(idOrPath: string): Promise<Doc>;
  create(doc: { path: string; title: string; body: string }): Promise<Doc>;

  /** Rejects with `conflict` when `baseVersion` is stale. */
  update(id: string, patch: { title?: string; body?: string; baseVersion?: string }): Promise<Doc>;
  comments(id: string): Promise<DocComment[]>;
  comment(id: string, comment: { body: string; anchorText?: string }): Promise<DocComment>;
  reply(commentId: string, body: string): Promise<DocComment>;
  resolve(commentId: string): Promise<void>;

  /**
   * Comments and replies on the given documents, oldest first by the time they were written. Same contract as
   * `Tracker.events`: an opaque cursor in and out, a re-read of the recent past (the office de-duplicates by
   * `externalId`), and the first call without a cursor only says where "now" is. The caller names the documents,
   * so a feed that is not per document is still bounded.
   */
  events(docs: string[], cursor?: string): Promise<EventPage<DocEvent>>;
}
