import type {
  ChatMessage,
  Doc,
  Member,
  PullRequest,
  RepoRef,
  Check,
  VcsPermission,
} from "../ports/index.js";

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
  review(
    repo: RepoRef,
    number: number,
    actor: string,
    state: "approved" | "changes_requested" | "commented",
    body?: string,
  ): Promise<void>;
  comment(repo: RepoRef, number: number, actor: string, body: string): Promise<void>;
  thread(
    repo: RepoRef,
    number: number,
    t: { path?: string; line?: number; comments: { author: string; body: string }[] },
  ): Promise<string>;
  check(repo: RepoRef, sha: string, c: { name: string; status: Check["status"] }): Promise<void>;
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
}

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
