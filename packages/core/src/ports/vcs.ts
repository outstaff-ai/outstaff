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
}

export interface ReviewThread {
  id: string;
  resolved: boolean;
  path?: string;
  line?: number;
  comments: { id: string; author: string; body: string }[];
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
  reviewThreads(repo: RepoRef, number: number): Promise<ReviewThread[]>;

  /** Resolves only when the last comment in the thread is `asLogin`'s. */
  resolveThread(
    repo: RepoRef,
    threadId: string,
    asLogin: string,
  ): Promise<{ resolved: boolean; reason?: string }>;

  /** For the trust model. */
  permission(repo: RepoRef, login: string): Promise<VcsPermission>;
  events(repos: RepoRef[], cursor?: string): Promise<EventPage<VcsEvent>>;
}
