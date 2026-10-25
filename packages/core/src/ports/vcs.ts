import type { EventPage } from "./events.js";
import type { Links } from "./links.js";
import type { RepoRef } from "./repo.js";

export interface PullRequest {
  repo: RepoRef;
  number: number;
  title: string;
  body: string;
  url: string;
  author: { login: string; kind: "human" | "agent" | "bot" };
  head: { ref: string; sha: string };
  base: { ref: string };
  state: "open" | "closed" | "merged";
  draft: boolean;
  mergeable: "clean" | "conflicting" | "unknown";
  updatedAt: string;
}

export interface Check {
  name: string;
  status: "pending" | "success" | "failure" | "neutral";
  url: string;

  /** What the check reports about itself (a check run's output summary), when it has one. */
  summary?: string;

  /** Set when the host can show this check's log through `Vcs.checkLog`; pass it back as is. */
  logId?: string;
}

/** The log of one failed step of a check. */
export interface CheckLogStep {
  name: string;

  /** The last lines of the step's log, oldest first, timestamps removed. */
  lines: string[];

  /** Lines of the step's log before `lines`. */
  omitted: number;
}

export interface CheckLog {
  /** Steps that failed; empty when the check did not fail or the host reports no failed step. */
  failedSteps: CheckLogStep[];
}

export interface ReviewThread {
  id: string;
  resolved: boolean;
  path?: string;
  line?: number;
  comments: { id: string; author: string; body: string }[];
}

/** One inline comment of a submitted review. */
export interface ReviewInlineComment {
  id: string;
  path: string;
  line?: number;
  body: string;
  url?: string;

  /** The review thread the comment opened or belongs to, when the host reports one. */
  threadId?: string;
}

export interface NewPullRequest {
  /** Branch with the changes; it must already be pushed. */
  head: string;

  /** Defaults to the repo's default branch. */
  base?: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface PullRequestUpdate {
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
}

export type ReviewVerdict = "approve" | "request_changes" | "comment";

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface Review {
  verdict: ReviewVerdict;
  body: string;
  comments?: ReviewComment[];
}

export type VcsPermission = "admin" | "write" | "read" | "none";

export interface VcsEvent {
  externalId: string;
  type:
    | "pr.opened"
    | "pr.merged"
    | "pr.closed"
    | "pr.review_submitted"
    | "pr.comment"
    | "pr.synchronize";
  repo: RepoRef;
  number: number;

  /** Login of whoever caused the event. */
  actor: string;
  at: string;
  data: Record<string, unknown>;
}

/** What a reaction goes on: a comment of the pull request conversation or an inline comment of a review. */
export interface ReactionTarget {
  kind: "conversation_comment" | "inline_comment";

  /** The comment id the host reports, as in `ReviewInlineComment.id` and the `commentId` of `pr.comment` events. */
  id: string;
}

export type Reaction = "eyes";

export interface Vcs {
  links: Pick<Links, "pr" | "commit" | "thread">;
  credentials(
    person: string,
    repo: RepoRef,
    access: "read" | "write",
  ): Promise<{ token: string; expiresAt: string; author?: { name: string; email: string } }>;
  listPullRequests(
    repo: RepoRef,
    filter?: { state?: "open" | "all"; author?: string },
  ): Promise<PullRequest[]>;

  /** With `waitForMergeable` an `unknown` mergeability is retried a few times. */
  getPullRequest(
    repo: RepoRef,
    number: number,
    opts?: { waitForMergeable?: boolean },
  ): Promise<PullRequest>;
  checks(repo: RepoRef, sha: string): Promise<Check[]>;

  /**
   * The failed steps of a check and the last `tail` lines (default 200) of each, for a check with a `logId`.
   * Secrets are masked. `forbidden` when the person's credentials cannot read logs; `not_found` for an unknown log.
   * Adapters whose host has no step logs leave it out.
   */
  checkLog?(repo: RepoRef, logId: string, opts?: { tail?: number }): Promise<CheckLog>;
  reviewThreads(repo: RepoRef, number: number): Promise<ReviewThread[]>;

  /**
   * The inline comments of one submitted review, oldest first, each with its thread when there is one.
   * `not_found` unless the review belongs to that pull request.
   */
  reviewComments(repo: RepoRef, number: number, reviewId: string): Promise<ReviewInlineComment[]>;

  /**
   * Resolves only when the last comment in the thread is `asLogin`'s. Without `asLogin` the adapter uses its own
   * identity (for example the container's own App bot), so callers need not know their login on the host.
   */
  resolveThread(
    repo: RepoRef,
    threadId: string,
    asLogin?: string,
  ): Promise<{ resolved: boolean; reason?: string }>;

  /**
   * The write operations act as the person this port instance belongs to (an agent's own identity, never the
   * office's) and refuse with `forbidden` when that person lacks a write grant on the repo.
   * Refuses (`invalid`) a `head` equal to the default branch.
   */
  openPullRequest(repo: RepoRef, input: NewPullRequest): Promise<PullRequest>;
  updatePullRequest(repo: RepoRef, number: number, patch: PullRequestUpdate): Promise<PullRequest>;

  /** A read grant is enough. Refuses (`forbidden`) reviewing one's own pull request. */
  submitReview(repo: RepoRef, number: number, review: Review): Promise<void>;

  /** Needs a write grant. `not_found` unless the thread belongs to that pull request. */
  replyToThread(repo: RepoRef, number: number, threadId: string, body: string): Promise<void>;

  /** A top-level comment on the pull request conversation. Needs a write grant. */
  commentOnPullRequest(repo: RepoRef, number: number, body: string): Promise<void>;

  /**
   * Adds the reaction as the person this port instance belongs to. Adding one that is already there is not an
   * error and adds nothing. Needs a write grant; `not_found` for an unknown comment.
   */
  react(repo: RepoRef, target: ReactionTarget, reaction: Reaction): Promise<void>;

  /** The unified diff of the pull request (read grant). */
  diff(repo: RepoRef, number: number): Promise<string>;

  /** For the trust model. */
  permission(repo: RepoRef, login: string): Promise<VcsPermission>;
  events(repos: RepoRef[], cursor?: string): Promise<EventPage<VcsEvent>>;

  /**
   * Webhook mode: verify the delivery (signature) and turn it into events; return `[]` for deliveries to ignore.
   * Throws `forbidden` when verification fails and `invalid` for a malformed body. Adapters without webhook
   * support leave it out.
   */
  parseWebhook?(headers: Record<string, string | undefined>, body: string): Promise<VcsEvent[]>;
}
