import type {
  ApiActivityItem,
  ApiAssignee,
  ApiColumn,
  ApiIssue,
  ApiLabel,
} from "@outstaff/integration.shared.itsaplan";
import type { createFakeState } from "./fake-state.js";
import type { createItsaplanFake } from "./itsaplan-fake.js";

export interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  params: Record<string, string>;
  json: any; // oxlint-disable-line no-explicit-any

  /** The multipart body of an upload. */
  form?: FormData;
}

export interface StubReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;

  /** Raw bytes, sent as they are instead of `body`. */
  buffer?: Uint8Array;
}

export type Handler = (req: StubRequest) => StubReply | unknown;

export interface Route {
  method: string;

  /** `:name` segments capture a decoded path segment; `*` matches the rest. */
  path: string;
  handler: Handler;
}

/** A column of the fake's project; it always serves every field. */
export type StoredColumn = Required<ApiColumn>;

export type StoredLabel = Required<ApiLabel>;

export type StoredAssignee = Required<ApiAssignee>;

/** An issue as the fake stores it: the full form, with the fields the API may leave out always set. */
export type StoredIssue = ApiIssue &
  Required<Pick<ApiIssue, "assigneeUserId" | "labelIds" | "createdAt">> & { description: string };

/** A row of the activity feed; the fake always serves the optional fields. */
export type StoredActivity = ApiActivityItem &
  Required<
    Pick<
      ApiActivityItem,
      "replyToId" | "actorUserId" | "actorName" | "body" | "action" | "issueTitle" | "payload"
    >
  >;

export interface FakeOptions {
  /** Column names; default is the Title Case set matching the canonical statuses. */
  columns?: { name: string; stateType: string }[];
  projectKey?: string;
  teamRef?: string;
}

/** What `extend` gets to add routes that share the fake's clock and acting member. */
export interface FakeShared {
  clock: () => string;
  err: (status: number, error: string, code?: string) => StubReply;
  actor: { userId: string; name: string };
}

export type FakeState = ReturnType<typeof createFakeState>;

export type ItsaplanFake = ReturnType<typeof createItsaplanFake>;
