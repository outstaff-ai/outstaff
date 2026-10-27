import type { RepoRef, VcsEvent } from "@outstaff/core";
import type { RestEvent } from "./api.types.js";

type Payload = RestEvent["payload"];
type EventBase = Pick<VcsEvent, "externalId" | "repo" | "actor" | "at">;
type EventMapper = (p: Payload, base: EventBase) => VcsEvent | undefined;

// The events feed reports a merge as its own action; webhooks send `closed` with `merged: true`.
const PR_ACTIONS = new Map<string, (merged: boolean) => VcsEvent["type"]>([
  ["opened", () => "pr.opened"],
  ["reopened", () => "pr.opened"],
  ["merged", () => "pr.merged"],
  ["closed", (merged) => (merged ? "pr.merged" : "pr.closed")],
  ["synchronize", () => "pr.synchronize"],
]);

function pullRequestData(pr: Payload | undefined): Record<string, unknown> {
  return {
    title: pr?.title,
    headRef: pr?.head?.ref,
    headSha: pr?.head?.sha,
    baseRef: pr?.base?.ref,
  };
}

function pullRequestEvent(p: Payload, base: EventBase): VcsEvent | undefined {
  const typeOf = PR_ACTIONS.get(p["action"]);
  if (!typeOf) {
    return undefined;
  }

  const pr = p["pull_request"];
  const data = {
    ...pullRequestData(pr),
    ...(p["action"] === "reopened" ? { reopened: true } : {}),
  };

  return { ...base, type: typeOf(Boolean(pr?.merged)), number: p["number"] ?? pr?.number, data };
}

function reviewEvent(p: Payload, base: EventBase): VcsEvent | undefined {
  // Webhooks say `submitted`; the repository events feed says `created`.
  if (p["action"] !== "submitted" && p["action"] !== "created") {
    return undefined;
  }

  const review = p["review"] ?? {};
  return {
    ...base,
    type: "pr.review_submitted",
    number: p["pull_request"].number,
    data: {
      state: String(review.state ?? "").toLowerCase(),
      body: review.body ?? "",
      reviewId: review.id,
      url: review.html_url,
    },
  };
}

function reviewCommentEvent(p: Payload, base: EventBase): VcsEvent | undefined {
  if (p["action"] !== "created") {
    return undefined;
  }

  const comment = p["comment"] ?? {};
  return {
    ...base,
    type: "pr.comment",
    number: p["pull_request"].number,
    data: {
      kind: "review_comment",
      body: comment.body ?? "",
      path: comment.path,
      commentId: comment.id,
      // An inline comment of a review; while that review is pending the host already announces it.
      ...(comment.pull_request_review_id != null
        ? { reviewId: comment.pull_request_review_id }
        : {}),
      url: comment.html_url,
    },
  };
}

function issueCommentEvent(p: Payload, base: EventBase): VcsEvent | undefined {
  if (p["action"] !== "created" || !p["issue"]?.pull_request) {
    return undefined;
  }

  const comment = p["comment"] ?? {};
  return {
    ...base,
    type: "pr.comment",
    number: p["issue"].number,
    data: {
      kind: "comment",
      body: comment.body ?? "",
      commentId: comment.id,
      url: comment.html_url,
    },
  };
}

const MAPPERS = new Map<string, EventMapper>([
  ["PullRequestEvent", pullRequestEvent],
  ["PullRequestReviewEvent", reviewEvent],
  ["PullRequestReviewCommentEvent", reviewCommentEvent],
  ["IssueCommentEvent", issueCommentEvent],
]);

/** Normalises one repo event; returns undefined for anything the office does not act on. */
export function toVcsEvent(repo: RepoRef, e: RestEvent): VcsEvent | undefined {
  const base = { externalId: e.id, repo, actor: e.actor?.login ?? "ghost", at: e.created_at };
  return MAPPERS.get(e.type)?.(e.payload, base);
}
