import type {
  ApiDoc,
  ApiDocComment,
  ApiDocSummary,
  Itsaplan,
  OptionalConnectionOptions,
} from "@outstaff/integration.shared.itsaplan";

export type KnowledgeOptions = OptionalConnectionOptions;

export interface Tree {
  items: ApiDocSummary[];
  byId: Map<number, ApiDocSummary>;
}

/** What reading document comments needs from the knowledge adapter. */
export interface DocEventDeps {
  api: Itsaplan;
  docs: string;
  idOf: (idOrPath: string) => Promise<number>;
  read: (id: number | string) => Promise<ApiDoc>;
  now: () => Date;
}

/** A comment read from a document, with its creation time in milliseconds (NaN when unreadable). */
export interface ReadComment {
  docId: number;
  comment: ApiDocComment;
  at: number;
}
