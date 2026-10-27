import type {
  RestIssueComment,
  RestReview,
  RestReviewComment,
} from "@outstaff/integration.vcs.github";
import type { Route } from "@outstaff/testing.http";
import { REVIEW_STATE, addComment, submitReview } from "./conversation.js";
import { NOT_FOUND, UNAUTHORIZED, pullOf, pullUrl } from "./model.js";
import type { GithubAuth, GithubStore } from "./types.js";

/** Reviews, their inline comments, and the conversation of a pull request. */
export function commentRoutes(s: GithubStore, auth: GithubAuth, repo: string): Route[] {
  return [
    {
      method: "POST",
      path: `${repo}/pulls/:n/reviews`,
      handler: async (r) => {
        const pr = pullOf(s, r.params["n"]);
        const actor = auth.actorOf(r);
        if (!pr || !actor) {
          return pr ? UNAUTHORIZED : NOT_FOUND;
        }

        const state = REVIEW_STATE[r.json.event];
        if (!state) {
          return { status: 422, body: { message: "Unprocessable: bad event" } };
        }

        const id = await submitReview(
          s,
          pr,
          actor,
          state,
          r.json.body ?? "",
          r.json.comments ?? [],
        );

        return { status: 200, body: { id, state } };
      },
    },
    {
      method: "GET",
      path: `${repo}/pulls/:n/reviews/:id/comments`,
      handler: (r) => {
        const review = s.reviews.get(Number(r.params["id"]));
        if (!review || review.prNumber !== Number(r.params["n"])) {
          return NOT_FOUND;
        }

        return review.comments.map((c): RestReviewComment => ({
          id: c.databaseId,
          path: c.path,
          line: c.line,
          body: c.body,
          html_url: `${pullUrl(s, review.prNumber)}#discussion_r${c.databaseId}`,
        }));
      },
    },
    {
      method: "GET",
      path: `${repo}/pulls/:n/reviews`,
      handler: (r) => {
        const pr = pullOf(s, r.params["n"]);
        return pr
          ? [...s.reviews]
              .filter(([, v]) => v.prNumber === pr.number)
              .map(([id, v]): RestReview => ({
                id,
                user: { login: v.author },
                body: v.body,
                state: v.state,
                submitted_at: v.at,
                commit_id: v.commitId,
                html_url: `${pullUrl(s, pr.number)}#pullrequestreview-${id}`,
              }))
          : NOT_FOUND;
      },
    },
    {
      method: "POST",
      path: `${repo}/issues/:n/comments`,
      handler: (r) => {
        const pr = pullOf(s, r.params["n"]);
        const actor = auth.actorOf(r);
        if (!pr || !actor) {
          return pr ? UNAUTHORIZED : NOT_FOUND;
        }

        return { status: 201, body: { id: addComment(s, pr, actor, r.json.body) } };
      },
    },
    {
      method: "GET",
      path: `${repo}/issues/:n/comments`,
      handler: (r) => {
        const pr = pullOf(s, r.params["n"]);
        return pr
          ? [...s.issueComments]
              .filter(([, c]) => c.prNumber === pr.number)
              .map(([id, c]): RestIssueComment => ({
                id,
                user: { login: c.author },
                body: c.body,
                created_at: c.at,
                updated_at: c.at,
                html_url: `${pullUrl(s, pr.number)}#issuecomment-${id}`,
              }))
          : NOT_FOUND;
      },
    },
  ];
}
