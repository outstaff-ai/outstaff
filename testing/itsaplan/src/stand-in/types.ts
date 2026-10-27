import type {
  ApiActivityItem,
  ApiAssignee,
  ApiColumn,
  ApiIssue,
  ApiLabel,
  ApiDoc,
  ApiDocComment,
  ApiProject,
  PmNode,
} from "@outstaff/integration.shared.itsaplan";
import type { StandInRequest } from "@outstaff/testing.http";

/** A column of the project; the stand-in always serves every field. */
export type StoredColumn = Required<ApiColumn>;

export type StoredLabel = Required<ApiLabel>;

/** A project member; the stand-in always knows the username. */
export type StoredMember = Required<ApiAssignee> & { username: string };

/** An issue as the stand-in stores it: the full form, with the fields the API may leave out always set. */
export type StoredIssue = ApiIssue &
  Required<Pick<ApiIssue, "assigneeUserId" | "labelIds" | "createdAt">> & { description: string };

/** A row of the activity feed; the stand-in always serves the optional fields. */
export type StoredActivity = ApiActivityItem &
  Required<
    Pick<
      ApiActivityItem,
      "replyToId" | "actorUserId" | "actorName" | "body" | "action" | "issueTitle" | "payload"
    >
  >;

/** A document as the stand-in stores it: the full form, with the fields the API may leave out always set. */
export type StoredDoc = ApiDoc &
  Required<Pick<ApiDoc, "parentId" | "createdAt" | "content" | "contentJson">> & {
    metadata: NonNullable<ApiDoc["metadata"]>;
  };

/** A comment on a document; the stand-in always knows its author. */
export type StoredDocComment = ApiDocComment &
  Required<
    Pick<
      ApiDocComment,
      "documentId" | "parentId" | "authorId" | "authorName" | "quote" | "from" | "to" | "resolvedAt"
    >
  >;

/** A file attached to an issue. Its public id is `pub-<position + 1>`. */
export interface StoredAttachment {
  issueId: number;
  name: string;
  mimetype: string;
  data: Uint8Array;
}

/** A relation made between two issues (`POST /issues/:id/links`), by identifier. */
export interface StoredLink {
  from: string;
  to: string;
  kind: string;
}

export interface ColumnSpec {
  name: string;
  stateType: string;
}

/** The project's fields besides its key and refs. */
export type ProjectFields = Omit<ApiProject["project"], "key" | "ref" | "teamRef">;

/** The editor positions of `quote` inside a page, or undefined when it is not inside one text block. */
export type QuoteRange = (doc: PmNode, quote: string) => [number, number] | undefined;

/** How the document routes check what they are sent and what they serve. */
export interface DocumentRules {
  /**
   * Given, comments are checked as Its a Plan checks them: a comment must name the page's current version, a new
   * thread the positions of its quote, a reply a comment that exists; a comment keeps the quote and positions it
   * was sent with. Without, comments are taken as they come: a reply takes the quote of its thread, a reply to an
   * unknown comment starts a thread, a missing quote is empty, and positions are null.
   */
  quoteRange?: QuoteRange;

  /** `search` (default): the listing filters by `q` and serves summaries. `all`: every page, whole, `q` ignored. */
  listing?: "search" | "all";
}

/** What tells one use of the stand-in from another; every default is the in-process fake of the adapter tests. */
export interface StandInOptions {
  /** Timestamps; default a deterministic clock that starts at 2026-01-01 and moves a second per read. */
  now?: () => string;

  /** API key to the userId it acts as; an unknown key is refused. Default `key-sam` as `u-sam`. */
  keys?: Record<string, string>;

  /** The project's members, served as its assignees. Default Sam Duarte (`u-sam`) and Rio Park (`u-rio`). */
  members?: StoredMember[];

  /** Status names; default the Title Case set matching the canonical statuses. */
  columns?: ColumnSpec[];
  projectKey?: string;
  teamRef?: string;
  project?: Partial<ProjectFields>;

  /** Prefix of every route, such as `/tracker`. Default none. */
  basePath?: string;
  documents?: DocumentRules;
}

/** The stand-in's data, shared by its routes. */
export interface ItsaplanStore {
  key: string;
  teamRef: string;
  ref: string;
  now: () => string;
  keys: Record<string, string>;
  project: ProjectFields;
  documents: DocumentRules;
  columns: StoredColumn[];
  labels: StoredLabel[];
  members: StoredMember[];
  issues: StoredIssue[];
  activity: StoredActivity[];
  links: StoredLink[];
  attachments: StoredAttachment[];

  /** Public ids of the attachments that were downloaded, in order. */
  served: string[];
  docs: StoredDoc[];
  docComments: StoredDocComment[];
  counters: { activity: number; label: number; doc: number; comment: number };
}

/** A route handler; `actor` is the userId the request's API key acts as. */
export type ActorHandler = (req: StandInRequest, actor: string) => unknown;

export interface ActorRoute {
  method: string;
  path: string;
  handler: ActorHandler;
}

/** What a new issue is made from. */
export interface IssueInput {
  title: string;
  description?: string;
  columnId: number;
  assigneeUserId?: string;
  labelIds?: number[];
  parentId?: number;
}
