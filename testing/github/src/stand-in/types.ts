import type {
  RestBranchProtection,
  RestCheckRun,
  RestEvent,
  RestIssueComment,
  RestPull,
  RestReview,
  RestReviewComment,
  RestRule,
  ThreadNode,
} from "@outstaff/integration.vcs.github";
import type { StandInReply, StandInRequest } from "@outstaff/testing.http";

/** An owner and a repository name. */
export interface StandInRepo {
  owner: string;
  name: string;
}

/** What GitHub computes for `mergeable` on a read. */
export type Mergeability = "clean" | "conflicting" | "unknown";

/** The git side of a repository: the stand-in reads heads, mergeability and diffs from it, and merges through it. */
export interface RepoBackend {
  /** The commit a branch points at, or undefined when there is no such branch. */
  sha(ref: string): Promise<string | undefined>;

  /** What a read of a pull request reports; GitHub may need several reads to know. */
  mergeable(base: string, head: string): Promise<Mergeability>;

  /** Whether merging would fail now; unlike `mergeable`, never counts as a read. */
  conflicts(base: string, head: string): Promise<boolean>;
  merge(base: string, head: string, message: string): Promise<unknown>;
  diff(base: string, head: string): Promise<string>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;

  /** How many commits `head` has that `base` does not. */
  ahead(base: string, head: string): Promise<number>;

  /** Branch name to commit. */
  branches(): Promise<Record<string, string>>;
}

/** The in-memory repository, with the controls the seed drives it by. */
export interface MemoryRepo extends RepoBackend {
  /** Points a branch at a commit, a made-up one by default; returns the commit. */
  commit(ref: string, sha?: string): string;

  /** What successive reads of a branch's pull request report as mergeable; the last answer sticks. */
  script(ref: string, answers: Mergeability[]): void;
}

/** Who a request is: the App behind a JWT, the bot behind an installation token, and the tokens an App gets. */
export interface GithubAuth {
  /** The App id a request's JWT belongs to; undefined when it is not a JWT of a known App. */
  appOf(req: StandInRequest): number | undefined;

  /** What `GET /app` answers as the App's slug. */
  slugOf(app: number): string | undefined;

  /** Answers `POST /app/installations/:id/access_tokens` for an App whose JWT checked out. */
  issue(app: number, req: StandInRequest): StandInReply;

  /** The login, with `[bot]`, behind an installation token; undefined when the token is not one. */
  actorOf(req: StandInRequest): string | undefined;
}

/** A pull request: the REST fields it serves, in camelCase. `head.sha` is the last head the stand-in saw. */
export type StoredPull = Pick<
  RestPull,
  "number" | "title" | "head" | "base" | "state" | "auto_merge"
> &
  Required<Pick<RestPull, "merged" | "draft">> & {
    body: NonNullable<RestPull["body"]>;
    login: NonNullable<RestPull["user"]>["login"];
    updatedAt: RestPull["updated_at"];

    /** Pushes that did not build on the previous head. */
    forcePushes: number;

    /** Taken into the merge queue, by `merge-async` or by an approval while auto-merge is on. */
    queued?: boolean;
    requested?: Set<string>;
    required?: Set<string>;
  };

type ThreadComment = ThreadNode["comments"]["nodes"][number];

/** A comment in a review thread, as served by `ThreadNode`; `seq` orders it among everything written. */
export interface StoredThreadComment {
  id: ThreadComment["id"];
  databaseId: NonNullable<ThreadComment["databaseId"]>;
  seq: number;
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
  seq: number;
  author: NonNullable<RestIssueComment["user"]>["login"];
  body: NonNullable<RestIssueComment["body"]>;
  at: RestIssueComment["created_at"];
}

/** A reaction on a conversation or an inline comment. */
export interface StoredReaction {
  kind: "conversation_comment" | "inline_comment";
  commentId: number;
  user: string;
  content: string;
  seq: number;
}

/** A check run on a commit; `job` marks one an Actions job backs. */
export type StoredCheckRun = Pick<RestCheckRun, "name" | "status" | "conclusion"> &
  Required<Pick<RestCheckRun, "id">> &
  Partial<Pick<RestCheckRun, "html_url" | "output">> & { job?: boolean };

/** An Actions job, keyed by its check run's id: its steps and its raw log text. */
export interface StoredJob {
  steps: { name: string; conclusion: string }[];
  log: string;
}

/** The id counters; each is bumped before use. */
export interface StandInCounters {
  eventId: number;
  thread: number;
  review: number;
  comment: number;
  checkId: number;

  /** Orders what is written, so a reaction is told from the reply that follows it. */
  seq: number;
}

/** What a repository allows: the merge queue and the merge methods. */
export interface MergeSettings {
  queue: boolean;
  methods: string[];
}

/** The default branch's classic protection, when it has one, and the rules its rulesets add. */
export interface BranchRules {
  protection?: RestBranchProtection;
  rules: RestRule[];
}

/** Everything the stand-in remembers. */
export interface GithubStore {
  repo: StandInRepo;
  backend: RepoBackend;
  now: () => string;
  counters: StandInCounters;
  prs: Map<number, StoredPull>;
  checks: Map<string, StoredCheckRun[]>;
  jobs: Map<number, StoredJob>;
  threads: Map<string, StoredThread>;
  reviews: Map<number, StoredReview>;
  issueComments: Map<number, StoredIssueComment>;
  reactions: StoredReaction[];
  perms: Map<string, string>;
  mergeSettings: MergeSettings;
  branch: BranchRules;
  events: RestEvent[];

  /** How long the merge queue takes to merge an enqueued pull request; never, when unset. */
  queueDelayMs: number | undefined;
}

export interface StandInOptions {
  repo: StandInRepo;

  /** ISO time of a write. Defaults to a clock that starts at 2026-01-01T00:00:00Z and ticks a second per call. */
  now?: () => string;

  /** Defaults to the in-process scheme: unverified JWTs and `tok_<person>` installation tokens. */
  auth?: (store: GithubStore) => GithubAuth;

  /** Defaults to an in-memory repository. */
  backend?: RepoBackend;

  /** How long the merge queue takes to merge an enqueued pull request; never, when unset. */
  queueDelayMs?: number;

  /** Where the REST API is served ("" by default; "/api/v3" on GitHub Enterprise). */
  apiPrefix?: string;

  /** Where GraphQL is served ("/graphql" by default). */
  graphqlPath?: string;

  /** Further repositories of the same owner: no pull requests and no events, but the office polls them. */
  more?: StandInRepo[];

  /** Login to permission level, for `collaborators/:login/permission`. */
  permissions?: Record<string, string>;
  mergeSettings?: MergeSettings;

  /** The rules of the default branch's rulesets; none by default. */
  rules?: RestRule[];
}
