import type { ConversationEntry, PullRequestReview, Vcs } from "@outstaff/core";
import type { RestIssueComment, RestPull, RestReview } from "#/api.types.js";
import { PERMISSIONS, repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

// A long conversation has more than the default ten pages; the newest entries are on the last ones.
const CONVERSATION_PAGES = 50;

function commentEntry(c: RestIssueComment): ConversationEntry {
  return {
    id: `comment-${c.id}`,
    kind: "comment",
    author: c.user?.login ?? "ghost",
    at: c.created_at,
    url: c.html_url,
    body: c.body ?? "",
  };
}

/** Pending reviews are invisible to others; one with neither text nor verdict only wraps inline comments. */
function isVisibleReview(r: RestReview, state: string): r is RestReview & { submitted_at: string } {
  return (
    Boolean(r.submitted_at) && state !== "pending" && (state !== "commented" || !!r.body?.trim())
  );
}

function reviewEntry(r: RestReview): ConversationEntry[] {
  const state = r.state.toLowerCase();
  if (!isVisibleReview(r, state)) {
    return [];
  }

  return [
    {
      id: `review-${r.id}`,
      kind: "review",
      author: r.user?.login ?? "ghost",
      at: r.submitted_at,
      url: r.html_url,
      body: r.body ?? "",
      state,
    },
  ];
}

/** A pull request's conversation, its review state, and reactions on its comments. */
export function conversationOperations(
  c: GithubContext,
): Pick<Vcs, "conversation" | "reviewState" | "react"> {
  const { http, apiToken, actingToken } = c;
  return {
    async conversation(repo, number, opts = {}) {
      const token = await apiToken(repo);
      const [comments, reviews] = await Promise.all([
        http.paginate<RestIssueComment[], RestIssueComment>(
          `${repoPath(repo)}/issues/${number}/comments`,
          {
            token,
            // The host filters by last update, which is never before creation; the exact cut by creation time is below.
            query: { per_page: 100, ...(opts.since ? { since: opts.since } : {}) },
          },
          (d) => d,
          CONVERSATION_PAGES,
        ),
        http.paginate<RestReview[], RestReview>(
          `${repoPath(repo)}/pulls/${number}/reviews`,
          { token, query: { per_page: 100 } },
          (d) => d,
          CONVERSATION_PAGES,
        ),
      ]);

      const since = opts.since === undefined ? undefined : Date.parse(opts.since);
      const entries: ConversationEntry[] = [
        ...comments.map(commentEntry),
        ...reviews.flatMap(reviewEntry),
      ]
        .filter((e) => since === undefined || Date.parse(e.at) >= since)
        .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));

      return opts.limit === undefined
        ? entries
        : entries.slice(Math.max(0, entries.length - opts.limit));
    },

    async react(repo, target, reaction) {
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      const path = target.kind === "conversation_comment" ? "issues" : "pulls";
      await http.request(
        "POST",
        `${repoPath(repo)}/${path}/comments/${encodeURIComponent(target.id)}/reactions`,
        { token, body: { content: reaction } },
      );
    },

    async reviewState(repo, number) {
      const token = await apiToken(repo);
      const [reviews, pull] = await Promise.all([
        http.paginate<RestReview[], RestReview>(
          `${repoPath(repo)}/pulls/${number}/reviews`,
          { token, query: { per_page: 100 } },
          (d) => d,
          CONVERSATION_PAGES,
        ),
        http.request<RestPull>("GET", `${repoPath(repo)}/pulls/${number}`, { token }),
      ]);

      const states: Record<string, PullRequestReview["state"] | undefined> = {
        approved: "approved",
        changes_requested: "changes_requested",
        commented: "commented",
        dismissed: "dismissed",
      };

      return {
        reviews: reviews
          .flatMap((r): PullRequestReview[] => {
            const state = states[r.state.toLowerCase()];
            // Pending reviews are invisible to others.
            if (!state || !r.submitted_at) {
              return [];
            }

            return [
              {
                id: String(r.id),
                author: r.user?.login ?? "ghost",
                state,
                at: r.submitted_at,
                ...(r.commit_id ? { commitSha: r.commit_id } : {}),
              },
            ];
          })
          .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at)),
        requestedReviewers: (pull.data.requested_reviewers ?? []).map((u) => u.login),
      };
    },
  };
}
