import type { PullRequest, RepoRef, Vcs, VcsPermission } from "@outstaff/core";
import type {
  RestCheckRun,
  RestEvent,
  RestIssueComment,
  RestPull,
  RestReview,
  RestReviewComment,
  ThreadNode,
} from "@outstaff/integration.vcs.github";

export interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  params: Record<string, string>;
  json: any; // oxlint-disable-line no-explicit-any
}

export interface StubReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;

  /** A non-JSON body, served as plain text. */
  text?: string;
}

export type Handler = (req: StubRequest) => StubReply | unknown;

export interface Route {
  method: string;

  /** `:name` segments capture a decoded path segment; `*` matches the rest. */
  path: string;
  handler: Handler;
}

export interface Clock {
  date: Date;
  now: () => Date;
  advance(ms: number): void;
}

/** A pull request in the GitHub fake: the REST fields it serves, in camelCase, plus what the seed sets. */
export type StoredPull = Pick<RestPull, "number" | "title" | "head" | "base" | "state"> &
  Required<Pick<RestPull, "merged" | "draft">> & {
    body: NonNullable<RestPull["body"]>;
    login: NonNullable<RestPull["user"]>["login"];
    updatedAt: RestPull["updated_at"];

    /** What `mergeable` reports on successive reads; the last one sticks. */
    mergeable: PullRequest["mergeable"][];
    requested?: Set<string>;
    required?: Set<string>;
  };

type ThreadComment = ThreadNode["comments"]["nodes"][number];

/** A comment in a review thread, as served by `ThreadNode`. */
export interface StoredThreadComment {
  id: ThreadComment["id"];
  databaseId: NonNullable<ThreadComment["databaseId"]>;
  author: NonNullable<ThreadComment["author"]>["login"];
  body: ThreadComment["body"];
}

/** A review thread on a pull request. */
export type StoredThread = Pick<ThreadNode, "id"> & {
  prNumber: RestPull["number"];
  resolved: ThreadNode["isResolved"];
  path: NonNullable<ThreadNode["path"]> | undefined;
  line: NonNullable<ThreadNode["line"]> | undefined;
  comments: StoredThreadComment[];
};

/** An inline comment of a submitted review. */
export type StoredReviewComment = Pick<RestReviewComment, "path" | "body"> & {
  databaseId: RestReviewComment["id"];
  line: NonNullable<RestReviewComment["line"]>;
};

/** A submitted review. */
export type StoredReview = Pick<RestReview, "state"> & {
  prNumber: RestPull["number"];
  author: NonNullable<RestReview["user"]>["login"];
  body: NonNullable<RestReview["body"]>;
  at: NonNullable<RestReview["submitted_at"]>;
  commitId: NonNullable<RestReview["commit_id"]>;
  comments: StoredReviewComment[];
};

/** A conversation comment on a pull request. */
export interface StoredIssueComment {
  prNumber: RestPull["number"];
  author: NonNullable<RestIssueComment["user"]>["login"];
  body: NonNullable<RestIssueComment["body"]>;
  at: RestIssueComment["created_at"];
}

/** A check run on a commit; `job` marks one an Actions job backs. */
export type StoredCheckRun = Pick<RestCheckRun, "name" | "status" | "conclusion"> &
  Required<Pick<RestCheckRun, "id">> & { job?: boolean };

/** An Actions job, keyed by its check run's id: its steps and its raw log text. */
export interface StoredJob {
  steps: { name: string; conclusion: string }[];
  log: string;
}

/** The fake's id and clock counters; each is bumped before use. */
export interface FakeCounters {
  tick: number;
  eventId: number;
  sha: number;
  thread: number;
  reviewCounter: number;
  commentCounter: number;
  checkId: number;
}

/** Everything the GitHub fake remembers, and the helpers its routes and seed share. */
export interface FakeState {
  repo: RepoRef;
  counters: FakeCounters;
  prs: Map<number, StoredPull>;
  checks: Map<string, StoredCheckRun[]>;
  jobs: Map<number, StoredJob>;
  threads: Map<string, StoredThread>;
  reviews: Map<number, StoredReview>;
  perms: Map<string, VcsPermission>;
  mergeSettings: { queue: boolean; methods: string[] };
  issueComments: Map<number, StoredIssueComment>;
  reactions: Map<string, Set<string>>;
  events: RestEvent[];
  inlineIds: () => Set<number>;
  clockIso: () => string;
  emit: (type: string, actor: string, payload: Record<string, unknown>) => void;
  need: (n: number) => StoredPull;
  rest: (pr: StoredPull) => RestPull;
  domain: (pr: StoredPull) => PullRequest;
  touch: (pr: StoredPull) => void;
  prPayload: (pr: StoredPull, action: string) => Record<string, unknown>;
  submitReview: (
    prNumber: number,
    actor: string,
    state: string,
    body: string,
    inline: Omit<StoredReviewComment, "databaseId">[],
  ) => number;
  etag: () => string;
}

/** The part of the adapter the seed calls back into, bound once the adapter exists. */
export type FakeVcsRef = Pick<Vcs, "getPullRequest">;
