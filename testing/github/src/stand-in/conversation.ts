import { emit, enqueue, headSha, nextSeq, pullUrl, touch } from "./model.js";
import type { GithubStore, StoredPull, StoredReview, StoredReviewComment } from "./types.js";

/** What a review's event becomes once submitted. */
export const REVIEW_STATE: Record<string, string> = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
};

type Inline = Omit<StoredReviewComment, "databaseId">;

/** An inline comment opens a thread and is announced when it is written, while its review is still pending. */
function addInline(s: GithubStore, pr: StoredPull, review: number, actor: string, c: Inline) {
  const n = s.counters;
  const thread = `PRRT_${++n.thread}`;
  const databaseId = ++n.comment;
  s.threads.set(thread, {
    id: thread,
    prNumber: pr.number,
    resolved: false,
    path: c.path,
    line: c.line,
    comments: [{ id: `${thread}_c0`, databaseId, seq: nextSeq(s), author: actor, body: c.body }],
  });

  touch(s, pr);
  emit(s, "PullRequestReviewCommentEvent", actor, {
    action: "created",
    pull_request: { number: pr.number },
    comment: {
      id: databaseId,
      body: c.body,
      path: c.path,
      pull_request_review_id: review,
      html_url: `${pullUrl(s, pr.number)}#discussion_r${databaseId}`,
    },
  });

  return { databaseId, path: c.path, line: c.line, body: c.body };
}

/** A review the way GitHub reports it: the inline comments first, then the review once it is submitted. */
export async function submitReview(
  s: GithubStore,
  pr: StoredPull,
  actor: string,
  state: string,
  body: string,
  inline: Inline[],
): Promise<number> {
  const id = ++s.counters.review;
  const review: StoredReview = {
    prNumber: pr.number,
    author: actor,
    state,
    body,
    at: s.now(),
    commitId: await headSha(s, pr),
    comments: [],
  };

  pr.requested?.delete(actor);
  s.reviews.set(id, review);
  for (const c of inline) {
    review.comments.push(addInline(s, pr, id, actor, c));
  }

  touch(s, pr);
  emit(s, "PullRequestReviewEvent", actor, {
    action: "submitted",
    pull_request: { number: pr.number },
    review: { id, state, body, html_url: `${pullUrl(s, pr.number)}#pullrequestreview-${id}` },
  });

  // The host's auto-merge: the approval meets the ruleset, so the pull request joins the merge queue.
  if (state === "APPROVED" && pr.auto_merge && pr.state === "open" && !pr.queued) {
    enqueue(s, pr, pr.login);
  }

  return id;
}

/** A comment on the pull request conversation. `linked` puts its link in the event, as the web UI's do. */
export function addComment(
  s: GithubStore,
  pr: StoredPull,
  actor: string,
  body: string,
  linked = false,
): number {
  const id = ++s.counters.comment;
  s.issueComments.set(id, {
    prNumber: pr.number,
    seq: nextSeq(s),
    author: actor,
    body,
    at: s.now(),
  });

  touch(s, pr);
  emit(s, "IssueCommentEvent", actor, {
    action: "created",
    issue: { number: pr.number, pull_request: {} },
    comment: {
      id,
      body,
      ...(linked ? { html_url: `${pullUrl(s, pr.number)}#issuecomment-${id}` } : {}),
    },
  });

  return id;
}
