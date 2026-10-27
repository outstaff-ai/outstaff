import type { Check, PullRequest, RepoRef, VcsPermission } from "@outstaff/core";
import type { RestCheckRun, RestPull } from "./api.types.js";

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
    ...(pr.auto_merge ? { autoMerge: true } : {}),
    updatedAt: pr.updated_at,
  };
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

const ACTIONS_JOB = /\/actions\/runs\/\d+\/job\/(\d+)/;

/** The GitHub Actions job id of a check run, whose log can be read; undefined for any other provider. */
export function actionsJobId(run: RestCheckRun): string | undefined {
  const fromUrl = ACTIONS_JOB.exec(run.details_url ?? "")?.[1];
  if (fromUrl) {
    return fromUrl;
  }

  return run.app?.slug === "github-actions" && run.id !== undefined ? String(run.id) : undefined;
}

const SUMMARY_MAX = 500;

/** What a check run says about itself, trimmed; undefined when it says nothing. */
export function checkSummary(run: RestCheckRun): string | undefined {
  const text = (run.output?.summary || run.output?.title || "").trim();
  if (!text) {
    return undefined;
  }

  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}...` : text;
}
