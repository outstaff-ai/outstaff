import type { PullRequest, RepoRef, VcsPermission } from "@outstaff/core";
import type { RestEvent, RestPull } from "@outstaff/integration.vcs.github";
import type {
  FakeState,
  StoredCheckRun,
  StoredIssueComment,
  StoredJob,
  StoredPull,
  StoredReview,
  StoredReviewComment,
  StoredThread,
} from "../types.js";

/** The fake's stored pull requests, threads, reviews and events, with the helpers that keep them consistent. */
export function createFakeState(repo: RepoRef): FakeState {
  const n = {
    tick: 0,
    eventId: 1000,
    sha: 0,
    thread: 0,
    reviewCounter: 0,
    commentCounter: 0,
    checkId: 5000,
  };

  const prs = new Map<number, StoredPull>();
  const checks = new Map<string, StoredCheckRun[]>();

  // Actions jobs by id (the id of their check run): steps with their conclusion, and the raw log text.
  const jobs = new Map<number, StoredJob>();
  const threads = new Map<string, StoredThread>();
  const reviews = new Map<number, StoredReview>();
  const perms = new Map<string, VcsPermission>();

  // Conversation comment ids, and the reactions on a comment (`<endpoint>:<id>` -> `<login>:<content>`).
  const issueComments = new Map<number, StoredIssueComment>();

  const reactions = new Map<string, Set<string>>();
  const inlineIds = () =>
    new Set([
      ...[...threads.values()].flatMap((t) => t.comments.map((c) => c.databaseId)),
      ...[...reviews.values()].flatMap((r) => r.comments.map((c) => c.databaseId)),
    ]);

  const events: RestEvent[] = [];
  const clockIso = () =>
    new Date(Date.parse("2026-01-01T00:00:00Z") + ++n.tick * 1000).toISOString();

  const emit = (type: string, actor: string, payload: Record<string, unknown>) => {
    events.unshift({
      id: String(++n.eventId),
      type,
      actor: { login: actor },
      created_at: clockIso(),
      payload,
    });
  };

  const need = (n: number): StoredPull => {
    const pr = prs.get(n);
    if (!pr) {
      throw Object.assign(new Error("not found"), { notFound: true });
    }

    return pr;
  };

  const rest = (pr: StoredPull): RestPull => {
    const next = pr.mergeable.length > 1 ? pr.mergeable.shift()! : (pr.mergeable[0] ?? "unknown");
    return {
      number: pr.number,
      node_id: `PR_${pr.number}`,
      title: pr.title,
      body: pr.body,
      user: { login: pr.login },
      head: pr.head,
      base: pr.base,
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.merged ? pr.updatedAt : null,
      draft: pr.draft,
      requested_reviewers: [...(pr.requested ?? [])].map((login) => ({ login })),
      updated_at: pr.updatedAt,
      mergeable:
        pr.state !== "open"
          ? null
          : next === "clean"
            ? true
            : next === "conflicting"
              ? false
              : null,
      mergeable_state:
        pr.state !== "open"
          ? "unknown"
          : next === "clean"
            ? "clean"
            : next === "conflicting"
              ? "dirty"
              : "unknown",
    };
  };

  const domain = (pr: StoredPull): PullRequest => ({
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: `https://github.example/${repo.owner}/${repo.name}/pull/${pr.number}`,
    author: { login: pr.login, kind: pr.login.endsWith("[bot]") ? "agent" : "human" },
    head: pr.head,
    base: pr.base,
    state: pr.merged ? "merged" : pr.state,
    draft: pr.draft,
    mergeable: "unknown",
    updatedAt: pr.updatedAt,
  });

  const touch = (pr: StoredPull) => void (pr.updatedAt = clockIso());
  const prPayload = (pr: StoredPull, action: string) => ({
    action,
    number: pr.number,
    pull_request: {
      number: pr.number,
      title: pr.title,
      merged: pr.merged,
      head: pr.head,
      base: pr.base,
    },
  });

  /** A batch review the way the host reports it: each inline comment is announced while it is pending, then the review. */
  const submitReview = (
    prNumber: number,
    actor: string,
    state: string,
    body: string,
    inline: Omit<StoredReviewComment, "databaseId">[],
  ): number => {
    const id = ++n.reviewCounter;
    const stored: StoredReview = {
      prNumber,
      author: actor,
      state,
      body,
      at: clockIso(),
      commitId: prs.get(prNumber)?.head.sha ?? "",
      comments: [],
    };

    prs.get(prNumber)?.requested?.delete(actor);
    reviews.set(id, stored);
    for (const c of inline) {
      const threadId = `PRRT_${++n.thread}`;
      const databaseId = ++n.commentCounter;
      threads.set(threadId, {
        id: threadId,
        prNumber,
        resolved: false,
        path: c.path,
        line: c.line,
        comments: [{ id: `${threadId}_c0`, databaseId, author: actor, body: c.body }],
      });

      stored.comments.push({ databaseId, ...c });
      emit("PullRequestReviewCommentEvent", actor, {
        action: "created",
        pull_request: { number: prNumber },
        comment: {
          id: databaseId,
          body: c.body,
          path: c.path,
          pull_request_review_id: id,
          html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${prNumber}#discussion_r${databaseId}`,
        },
      });
    }

    emit("PullRequestReviewEvent", actor, {
      action: "submitted",
      pull_request: { number: prNumber },
      review: { id, state, body },
    });

    return id;
  };

  const etag = () => `W/"${n.eventId}"`;

  return {
    repo,
    counters: n,
    prs,
    checks,
    jobs,
    threads,
    reviews,
    perms,
    mergeSettings: { queue: false, methods: ["merge", "squash"] },
    issueComments,
    reactions,
    events,
    inlineIds,
    clockIso,
    emit,
    need,
    rest,
    domain,
    touch,
    prPayload,
    submitReview,
    etag,
  };
}
