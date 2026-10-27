import type {
  ChatFile,
  ChatMessage,
  Doc,
  Member,
  PullRequest,
  ReactionTarget,
  RepoRef,
  Check,
  VcsPermission,
} from "#/ports/index.js";

// Seeds let a contract kit create the data it needs. A fake seeds in memory; an env-gated real adapter
// seeds through the platform API and may leave out what it cannot do (the kit then skips those cases).
// `forbiddenCall` is a call that must reject with `forbidden`.

export interface TrackerSeed {
  /** Add a person who can be assigned. */
  member(m: { name: string; kind?: Member["kind"] }): Promise<Member>;
  forbiddenCall?(): Promise<unknown>;
}

export interface KnowledgeSeed {
  doc(d: { path: string; title: string; body: string }): Promise<Doc>;
  forbiddenCall?(): Promise<unknown>;
}

export interface NewSeedPullRequest {
  title: string;
  body?: string;
  author?: PullRequest["author"];
  head?: { ref: string; sha?: string };
  base?: { ref: string };
  draft?: boolean;

  /** Mergeability returned by successive reads; the last value sticks. Default `["clean"]`. */
  mergeable?: PullRequest["mergeable"][];
}

export interface VcsSeed {
  repo: RepoRef;

  /** The login the subject acts as when `resolveThread` gets no login; the kit skips that case when unset. */
  selfLogin?: string;
  pullRequest(repo: RepoRef, pr: NewSeedPullRequest): Promise<PullRequest>;

  /** Push a new commit to the PR branch (emits `pr.synchronize`). */
  push(repo: RepoRef, number: number, actor: string): Promise<PullRequest>;
  merge(repo: RepoRef, number: number, actor: string): Promise<PullRequest>;
  close(repo: RepoRef, number: number, actor: string): Promise<PullRequest>;

  /**
   * Submit a review, optionally with inline comments; each one opens a review thread. Resolves to the review id.
   * The inline comments of a batch review are announced as `pr.comment` events (with the `reviewId`) before the
   * `pr.review_submitted` event, the way a host reports a pending review.
   */
  review(
    repo: RepoRef,
    number: number,
    actor: string,
    state: "approved" | "changes_requested" | "commented",
    body?: string,
    comments?: { path: string; line: number; body: string }[],
  ): Promise<string>;

  /**
   * Ask a person for a review (they are then in `requestedReviewers` until they review). Only for subjects that
   * support merging; the kit skips the merge cases when unset.
   */
  requestReview?(repo: RepoRef, number: number, login: string): Promise<void>;

  /** Mark a check as required for merging (by name), or set how the repository merges. Merge cases only. */
  requireCheck?(repo: RepoRef, number: number, name: string): Promise<void>;
  mergeSettings?(
    repo: RepoRef,
    o: { queue?: boolean; methods?: ("merge" | "squash")[] },
  ): Promise<void>;

  /** A comment on the pull request conversation. Resolves to the comment id. */
  comment(repo: RepoRef, number: number, actor: string, body: string): Promise<string>;

  /** Who reacted to a comment with what, for the kit to see the effect of `react`. */
  reactions?(repo: RepoRef, target: ReactionTarget): Promise<{ user: string; reaction: string }[]>;
  thread(
    repo: RepoRef,
    number: number,
    t: { path?: string; line?: number; comments: { author: string; body: string }[] },
  ): Promise<string>;
  check(
    repo: RepoRef,
    sha: string,
    c: {
      name: string;
      status: Check["status"];

      /** Gives the check a readable log: its steps in order, `failed` ones included in `checkLog`. */
      log?: { steps: { name: string; failed?: boolean; lines: string[] }[] };
    },
  ): Promise<void>;
  permission(repo: RepoRef, login: string, level: VcsPermission): Promise<void>;
  forbiddenCall?(): Promise<unknown>;
}

export interface InboundMessage {
  channel: string;
  thread?: string;
  authorId: string;
  authorName?: string;
  text: string;
  trusted?: boolean;
  bot?: boolean;

  /** Files shared in the message, with their bytes. */
  files?: { name: string; mimetype: string; data: Uint8Array }[];
}

/** What a seeded message carries for a file, so the kit can compare it with what `download` returns. */
export type SeededFile = ChatFile;

export interface ChatSeed {
  channel: string;
  userId: string;

  /** Deliver a message as if a person sent it. Resolves once the handler has finished. */
  inbound(m: InboundMessage): Promise<ChatMessage>;
}

export interface RuntimeSeed {
  /** Queue a run that says `text` and finishes ok. */
  script(text: string): Promise<void>;
}
