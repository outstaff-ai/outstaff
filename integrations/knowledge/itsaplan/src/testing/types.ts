import type { KnowledgeSeed } from "@outstaff/core/contracts";
import type { ItsaplanFake as TrackerFake } from "../../../../tracker/itsaplan/src/testing/types.js";
import type { ApiDoc, ApiDocComment } from "../types.js";

/** A document as the fake stores it: the full form, with the fields the API may leave out always set. */
export type StoredDoc = ApiDoc &
  Required<Pick<ApiDoc, "parentId" | "createdAt" | "content" | "contentJson">> & {
    metadata: NonNullable<ApiDoc["metadata"]>;
  };

/** A comment on a document; the fake always serves the optional fields. */
export type StoredDocComment = ApiDocComment &
  Required<
    Pick<
      ApiDocComment,
      "documentId" | "parentId" | "authorId" | "authorName" | "quote" | "from" | "to" | "resolvedAt"
    >
  >;

export type ItsaplanFake = TrackerFake & {
  state: TrackerFake["state"] & { docs: StoredDoc[]; docComments: StoredDocComment[] };
  knowledgeSeed: KnowledgeSeed;
};

/** The body of a request that comments on a document. */
export interface NewDocComment {
  body: string;
  parentId?: string;
  quote?: string;
  from?: number;
  to?: number;
  version: number;
}
