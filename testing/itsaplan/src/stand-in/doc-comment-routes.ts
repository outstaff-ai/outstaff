import type { StandInReply } from "@outstaff/testing.http";
import { commentDoc, docById } from "./model.js";
import { err } from "./store.js";
import type {
  ActorRoute,
  ItsaplanStore,
  QuoteRange,
  StoredDoc,
  StoredDocComment,
} from "./types.js";

/** The body of `POST .../comments`. */
interface CommentBody {
  body: string;
  parentId?: string;
  quote?: string;
  from?: number;
  to?: number;
  version: number;
}

type CommentFields = Pick<StoredDocComment, "parentId" | "quote" | "from" | "to">;

/** Whether a new thread names where its quote sits in the page. */
const quoteAt = (d: StoredDoc, b: CommentBody, quoteRange: QuoteRange) => {
  const range = d.contentJson && b.quote ? quoteRange(d.contentJson, b.quote) : undefined;
  return range !== undefined && range[0] === b.from && range[1] === b.to;
};

/** Why Its a Plan refuses the comment, if it does: a stale version, an unknown parent or a misplaced quote. */
function refusalOf(
  s: ItsaplanStore,
  d: StoredDoc,
  b: CommentBody,
  quoteRange: QuoteRange,
): StandInReply | undefined {
  if (b.version !== d.version) {
    return err(409, "The page changed; read it again.", "version_conflict");
  }

  if (b.parentId) {
    return s.docComments.some((c) => c.id === b.parentId)
      ? undefined
      : err(404, "comment not found");
  }

  return quoteAt(d, b, quoteRange) ? undefined : err(400, "The quote is not at those positions.");
}

/** Its a Plan's checks; the fields of the comment, or the refusal. */
function checked(
  s: ItsaplanStore,
  d: StoredDoc,
  b: CommentBody,
  quoteRange: QuoteRange,
): CommentFields | { refusal: StandInReply } {
  const refusal = refusalOf(s, d, b, quoteRange);
  if (refusal) {
    return { refusal };
  }

  return {
    parentId: b.parentId ?? null,
    quote: b.quote ?? null,
    from: b.from ?? null,
    to: b.to ?? null,
  };
}

/** Taken as it comes: a reply joins its thread's quote; an unknown parent starts a thread. */
function loose(s: ItsaplanStore, b: CommentBody): CommentFields {
  const parent = s.docComments.find((c) => c.id === b.parentId);
  return {
    parentId: parent?.id ?? null,
    quote: parent?.quote ?? b.quote ?? "",
    from: null,
    to: null,
  };
}

function postComment(s: ItsaplanStore, actor: string, id: string, b: CommentBody) {
  const d = docById(s, id);
  if (!d) {
    return err(404, "document not found");
  }

  const { quoteRange } = s.documents;
  const fields = quoteRange ? checked(s, d, b, quoteRange) : loose(s, b);
  if ("refusal" in fields) {
    return fields.refusal;
  }

  const row = commentDoc(s, actor, { documentId: d.id, body: b.body, ...fields });
  return { status: 201, body: { id: row.id } };
}

/** Comment threads on a document: list, comment or reply, resolve. */
export function docCommentRoutes(s: ItsaplanStore): ActorRoute[] {
  return [
    {
      method: "GET",
      path: "/projects/:p/documents/:id/comments",
      handler: (r) =>
        s.docComments
          .filter((c) => c.documentId === Number(r.params["id"]))
          .map((c) => ({ ...c, documentVersion: 1, orphaned: false, updatedAt: c.createdAt })),
    },
    {
      method: "POST",
      path: "/projects/:p/documents/:id/comments",
      handler: (r, actor) => postComment(s, actor, r.params["id"]!, r.json),
    },
    {
      method: "PATCH",
      path: "/projects/:p/documents/:id/comments/:cid",
      handler: (r) => {
        const c = s.docComments.find(
          (x) => x.id === r.params["cid"] && x.documentId === Number(r.params["id"]),
        );

        if (!c) {
          return err(404, "comment not found");
        }

        if (r.json.resolved) {
          c.resolvedAt = s.now();
        }

        return c;
      },
    },
  ];
}
