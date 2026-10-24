import type { Check, PullRequest, RepoRef, VcsEvent, VcsPermission } from "@outstaff/core";

export interface RestPull {
  number: number;
  node_id?: string;
  title: string;
  body: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  updated_at: string;
}

const BOT_SUFFIX = "[bot]";

export const stripBot = (login: string): string =>
  login.endsWith(BOT_SUFFIX) ? login.slice(0, -BOT_SUFFIX.length) : login;

/** An agent is a login that is exactly some person's identity; any other `[bot]` login is a bot, anything else a human. */
export function authorKind(
  login: string,
  isAgentLogin: (login: string) => boolean,
): PullRequest["author"]["kind"] {
  if (isAgentLogin(login)) {
    return "agent";
  }

  return login.endsWith(BOT_SUFFIX) ? "bot" : "human";
}

export function mergeability(
  pr: Pick<RestPull, "mergeable" | "mergeable_state" | "state" | "merged" | "merged_at">,
): PullRequest["mergeable"] {
  if (pr.mergeable_state === "dirty" || pr.mergeable === false) {
    return "conflicting";
  }

  if (pr.mergeable === true && pr.mergeable_state !== "unknown") {
    return "clean";
  }

  return "unknown";
}

export function toPullRequest(
  repo: RepoRef,
  pr: RestPull,
  url: string,
  isAgentLogin: (login: string) => boolean,
): PullRequest {
  const login = pr.user?.login ?? "ghost";
  const merged = pr.merged === true || (pr.merged_at ?? null) !== null;
  return {
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    url,
    author: { login, kind: authorKind(login, isAgentLogin) },
    head: { ref: pr.head.ref, sha: pr.head.sha },
    base: { ref: pr.base.ref },
    state: merged ? "merged" : pr.state,
    draft: pr.draft === true,
    mergeable: mergeability(pr),
    updatedAt: pr.updated_at,
  };
}

export interface RestCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
}

export function checkRunStatus(run: RestCheckRun): Check["status"] {
  if (run.status !== "completed") {
    return "pending";
  }

  switch (run.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "cancelled":
    case "action_required":
    case "startup_failure":
      return "failure";
    default:
      return "neutral";
  }
}

export function commitStatusState(state: string): Check["status"] {
  return state === "success"
    ? "success"
    : state === "failure" || state === "error"
      ? "failure"
      : "pending";
}

export function permissionLevel(value: string): VcsPermission {
  switch (value) {
    case "admin":
      return "admin";
    case "maintain":
    case "write":
      return "write";
    case "triage":
    case "read":
      return "read";
    default:
      return "none";
  }
}

export interface RestEvent {
  id: string;
  type: string;
  actor?: { login: string } | null;
  created_at: string;
  payload: Record<string, any>; // oxlint-disable-line no-explicit-any
}

/** Normalises one repo event; returns undefined for anything the office does not act on. */
export function toVcsEvent(repo: RepoRef, e: RestEvent): VcsEvent | undefined {
  const p = e.payload;
  const base = { externalId: e.id, repo, actor: e.actor?.login ?? "ghost", at: e.created_at };
  switch (e.type) {
    case "PullRequestEvent": {
      const pr = p["pull_request"];
      const number: number = p["number"] ?? pr?.number;
      const data = {
        title: pr?.title,
        headRef: pr?.head?.ref,
        headSha: pr?.head?.sha,
        baseRef: pr?.base?.ref,
      };

      switch (p["action"]) {
        case "opened":
          return { ...base, type: "pr.opened", number, data };
        case "reopened":
          return { ...base, type: "pr.opened", number, data: { ...data, reopened: true } };
        // The events feed reports a merge as its own action; webhooks send `closed` with `merged: true`.
        case "merged":
          return { ...base, type: "pr.merged", number, data };
        case "closed":
          return { ...base, type: pr?.merged ? "pr.merged" : "pr.closed", number, data };
        case "synchronize":
          return { ...base, type: "pr.synchronize", number, data };
        default:
          return undefined;
      }
    }

    case "PullRequestReviewEvent":
      // Webhooks say `submitted`; the repository events feed says `created`.
      if (p["action"] !== "submitted" && p["action"] !== "created") {
        return undefined;
      }

      return {
        ...base,
        type: "pr.review_submitted",
        number: p["pull_request"].number,
        data: {
          state: String(p["review"]?.state ?? "").toLowerCase(),
          body: p["review"]?.body ?? "",
          reviewId: p["review"]?.id,
          url: p["review"]?.html_url,
        },
      };
    case "PullRequestReviewCommentEvent":
      if (p["action"] !== "created") {
        return undefined;
      }

      return {
        ...base,
        type: "pr.comment",
        number: p["pull_request"].number,
        data: {
          kind: "review_comment",
          body: p["comment"]?.body ?? "",
          path: p["comment"]?.path,
          commentId: p["comment"]?.id,
          // An inline comment of a review; while that review is pending the host already announces it.
          ...(p["comment"]?.pull_request_review_id != null
            ? { reviewId: p["comment"].pull_request_review_id }
            : {}),
          url: p["comment"]?.html_url,
        },
      };
    case "IssueCommentEvent":
      if (p["action"] !== "created" || !p["issue"]?.pull_request) {
        return undefined;
      }

      return {
        ...base,
        type: "pr.comment",
        number: p["issue"].number,
        data: {
          kind: "comment",
          body: p["comment"]?.body ?? "",
          commentId: p["comment"]?.id,
          url: p["comment"]?.html_url,
        },
      };
    default:
      return undefined;
  }
}
