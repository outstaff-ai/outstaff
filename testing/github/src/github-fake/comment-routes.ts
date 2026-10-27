import type {
  RestIssueComment,
  RestReview,
  RestReviewComment,
} from "@outstaff/integration.vcs.github";
import { actorOf } from "./requests.js";
import type { FakeState, Route } from "../types.js";

/** Reviews, review comments, conversation comments and reactions. */
export function commentRoutes(s: FakeState): Route[] {
  const {
    repo,
    counters: n,
    prs,
    reviews,
    issueComments,
    reactions,
    inlineIds,
    submitReview,
    emit,
    clockIso,
  } = s;

  return [
    {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/pulls/:n/reviews`,
      handler: (r) => {
        const pr = prs.get(Number(r.params["n"]));
        if (!pr) {
          return { status: 404, body: { message: "Not Found" } };
        }

        const actor = `${actorOf(r)}[bot]`;
        const state = {
          APPROVE: "APPROVED",
          REQUEST_CHANGES: "CHANGES_REQUESTED",
          COMMENT: "COMMENTED",
        }[r.json.event as string];

        if (!state) {
          return { status: 422, body: { message: "Unprocessable: bad event" } };
        }

        const id = submitReview(pr.number, actor, state, r.json.body, r.json.comments ?? []);

        return { status: 200, body: { id, state } };
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/:n/reviews/:id/comments`,
      handler: (r) => {
        const review = reviews.get(Number(r.params["id"]));
        if (!review || review.prNumber !== Number(r.params["n"])) {
          return { status: 404, body: { message: "Not Found" } };
        }

        return review.comments.map((c): RestReviewComment => ({
          id: c.databaseId,
          path: c.path,
          line: c.line,
          body: c.body,
          html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${review.prNumber}#discussion_r${c.databaseId}`,
        }));
      },
    },
    {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/issues/:n/comments`,
      handler: (r) => {
        const pr = prs.get(Number(r.params["n"]));
        if (!pr) {
          return { status: 404, body: { message: "Not Found" } };
        }

        const id = ++n.commentCounter;
        issueComments.set(id, {
          prNumber: pr.number,
          author: `${actorOf(r)}[bot]`,
          body: r.json.body,
          at: clockIso(),
        });

        emit("IssueCommentEvent", `${actorOf(r)}[bot]`, {
          action: "created",
          issue: { number: pr.number, pull_request: {} },
          comment: { id, body: r.json.body },
        });

        return { status: 201, body: { id } };
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/issues/:n/comments`,
      handler: (r) => {
        const n = Number(r.params["n"]);
        if (!prs.has(n)) {
          return { status: 404, body: { message: "Not Found" } };
        }

        return [...issueComments]
          .filter(([, c]) => c.prNumber === n)
          .map(([id, c]): RestIssueComment => ({
            id,
            user: { login: c.author },
            body: c.body,
            created_at: c.at,
            updated_at: c.at,
            html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${n}#issuecomment-${id}`,
          }));
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/:n/reviews`,
      handler: (r) => {
        const n = Number(r.params["n"]);
        if (!prs.has(n)) {
          return { status: 404, body: { message: "Not Found" } };
        }

        return [...reviews]
          .filter(([, v]) => v.prNumber === n)
          .map(([id, v]): RestReview => ({
            id,
            user: { login: v.author },
            body: v.body,
            state: v.state,
            submitted_at: v.at,
            commit_id: v.commitId,
            html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${n}#pullrequestreview-${id}`,
          }));
      },
    },
    ...(["issues", "pulls"] as const).map((kind): Route => ({
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/${kind}/comments/:id/reactions`,
      handler: (r) => {
        const id = Number(r.params["id"]);
        const known = kind === "issues" ? issueComments.has(id) : inlineIds().has(id);
        if (!known) {
          return { status: 404, body: { message: "Not Found" } };
        }

        const key = `${kind}:${id}`;
        const set = reactions.get(key) ?? new Set<string>();
        const entry = `${actorOf(r)}[bot]:${r.json.content}`;
        const created = !set.has(entry);
        set.add(entry);
        reactions.set(key, set);
        return { status: created ? 201 : 200, body: { id, content: r.json.content } };
      },
    })),
  ];
}
