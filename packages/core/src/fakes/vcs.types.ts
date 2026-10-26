import type {
  Check,
  ConversationEntry,
  MergeOptions,
  PullRequest,
  PullRequestReview,
  ReactionTarget,
  RepoRef,
  ReviewInlineComment,
  ReviewThread,
  Vcs,
  VcsEvent,
  VcsPermission,
} from "../ports/index.js";
import type { VcsSeed } from "../contracts/seeds.js";
import type { EventLog } from "./util.js";

export interface StoredPr {
  pr: PullRequest;
  mergeable: PullRequest["mergeable"][];
  threads: ReviewThread[];
  reviews: Map<string, ReviewInlineComment[]>;
  conversation: ConversationEntry[];
  reviewList: PullRequestReview[];
  requested: Set<string>;
  required: Set<string>;
}

/** The state of one fake vcs and the helpers over it, shared by its seed, reads and writes. */
export interface FakeVcsState {
  host: string;
  now: () => Date;
  self: string;
  retries: number;
  prs: Map<string, Map<number, StoredPr>>;
  checks: Map<string, Check[]>;
  logs: Map<string, NonNullable<Parameters<VcsSeed["check"]>[2]["log"]>["steps"]>;
  perms: Map<string, VcsPermission>;
  log: EventLog<VcsEvent>;
  counters: { event: number; sha: number; thread: number; comment: number; review: number };

  // Conversation comments by id, and who reacted with what to a comment (`kind:id` -> `login:reaction`).
  conversation: Map<string, string>;
  reactions: Map<string, Set<string>>;
  mergeSettings: Map<string, MergeOptions>;
  defaultBranch: string;
  defaultRepo: RepoRef;
  links: Vcs["links"];
  reactionKey: (repo: RepoRef, t: ReactionTarget) => string;
  knows: (repo: RepoRef, t: ReactionTarget) => boolean;
  key: (r: RepoRef) => string;
  withHost: (r: RepoRef) => RepoRef;
  newSha: () => string;
  emit: (
    type: VcsEvent["type"],
    repo: RepoRef,
    number: number,
    actor: string,
    data?: Record<string, unknown>,
  ) => void;
  need: (repo: RepoRef, number: number) => StoredPr;
  read: (s: StoredPr) => PullRequest;
  noteComment: (repo: RepoRef, number: number, id: string, author: string, body: string) => void;
  touch: (s: StoredPr) => void;
  settingsOf: (repo: RepoRef) => MergeOptions;

  /** Records a submitted review: it answers a request for that reviewer and is listed for `reviewState`. */
  record: (s: StoredPr, id: string, author: string, state: PullRequestReview["state"]) => void;
  grant: (repo: RepoRef, level: "write" | "read") => void;
}

export type VcsReads = Pick<
  Vcs,
  | "credentials"
  | "listPullRequests"
  | "getPullRequest"
  | "checks"
  | "checkLog"
  | "reviewThreads"
  | "conversation"
  | "reviewComments"
  | "resolveThread"
  | "reviewState"
  | "requiredChecks"
  | "mergeOptions"
  | "diff"
  | "permission"
  | "events"
>;

export type VcsWrites = Pick<
  Vcs,
  | "openPullRequest"
  | "updatePullRequest"
  | "submitReview"
  | "mergePullRequest"
  | "replyToThread"
  | "commentOnPullRequest"
  | "react"
>;
