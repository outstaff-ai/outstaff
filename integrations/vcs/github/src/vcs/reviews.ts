import {
  PortError,
  type RepoRef,
  type ReviewInlineComment,
  type ReviewThread,
  type Vcs,
} from "@outstaff/core";
import { stripBot } from "../mapping.js";
import type { RestPull, RestReviewComment, ThreadNode, ThreadsData } from "../api.types.js";
import { PERMISSIONS, repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

const REPLY_MUTATION = `mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}`;
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved path line originalLine comments(first:100){nodes{id databaseId body author{login}}}}}}}}`;
const LAST_COMMENT_QUERY = `query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved comments(last:1){nodes{author{login}}}}}}`;
const RESOLVE_MUTATION = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`;

/** Reviews need only pull request access, so a read-granted person can review. */
const REVIEW_PERMISSIONS = { pull_requests: "write" } as const;
const REVIEW_EVENTS = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
} as const;

type ReviewOperations =
  | "reviewThreads"
  | "reviewComments"
  | "resolveThread"
  | "submitReview"
  | "replyToThread";

/** Review threads and inline comments: reading, replying, resolving, and submitting reviews. */
export function reviewOperations(c: GithubContext): Pick<Vcs, ReviewOperations> {
  const { http, self, apiToken, own, actingToken } = c;

  async function threadNodes(repo: RepoRef, number: number, token: string): Promise<ThreadNode[]> {
    const nodes: ThreadNode[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data: ThreadsData = await http.graphql<ThreadsData>(token, THREADS_QUERY, {
        owner: repo.owner,
        name: repo.name,
        number,
        after,
      });

      const threads = data.repository?.pullRequest?.reviewThreads;
      if (!threads) {
        throw new PortError(
          "not_found",
          `Pull request ${repo.owner}/${repo.name}#${number} not found.`,
        );
      }

      nodes.push(...threads.nodes);
      if (!threads.pageInfo.hasNextPage) {
        break;
      }

      after = threads.pageInfo.endCursor;
    }

    return nodes;
  }

  return {
    async reviewThreads(repo, number) {
      const nodes = await threadNodes(repo, number, await apiToken(repo));
      return nodes.map((n): ReviewThread => {
        const line = n.line ?? n.originalLine;
        return {
          id: n.id,
          resolved: n.isResolved,
          ...(n.path ? { path: n.path } : {}),
          ...(line !== null ? { line } : {}),
          comments: n.comments.nodes.map((c) => ({
            id: c.id,
            author: c.author?.login ?? "ghost",
            body: c.body,
          })),
        };
      });
    },

    async reviewComments(repo, number, reviewId) {
      const token = await apiToken(repo);
      const found = await http.paginate<RestReviewComment[], RestReviewComment>(
        `${repoPath(repo)}/pulls/${number}/reviews/${encodeURIComponent(reviewId)}/comments`,
        { token, query: { per_page: 100 } },
        (d) => d,
      );

      if (found.length === 0) {
        return [];
      }

      const threadOf = new Map<number, string>();
      for (const node of await threadNodes(repo, number, token)) {
        for (const c of node.comments.nodes) {
          if (c.databaseId !== null) {
            threadOf.set(c.databaseId, node.id);
          }
        }
      }

      return found.map((c): ReviewInlineComment => {
        const line = c.line ?? c.original_line;
        const threadId = threadOf.get(c.id);
        return {
          id: String(c.id),
          path: c.path,
          ...(typeof line === "number" ? { line } : {}),
          body: c.body,
          ...(c.html_url ? { url: c.html_url } : {}),
          ...(threadId ? { threadId } : {}),
        };
      });
    },

    async resolveThread(repo, threadId, login) {
      const app = own();
      const asLogin = login ?? (app ? `${await app.slug()}[bot]` : undefined);
      if (asLogin === undefined) {
        throw new PortError(
          "forbidden",
          "Resolving review threads needs this container's own GitHub App.",
        );
      }

      const token = await apiToken(repo);
      const read = await http.graphql<{
        node: {
          id: string;
          isResolved: boolean;
          comments: { nodes: { author: { login: string } | null }[] };
        } | null;
      }>(token, LAST_COMMENT_QUERY, { id: threadId });

      if (!read.node?.id) {
        throw new PortError("not_found", `Review thread ${threadId} not found.`);
      }

      if (read.node.isResolved) {
        return { resolved: true };
      }

      const last = read.node.comments.nodes[0]?.author?.login;
      // GraphQL reports Apps without the "[bot]" suffix that REST uses.
      if (!last || stripBot(last).toLowerCase() !== stripBot(asLogin).toLowerCase()) {
        return {
          resolved: false,
          reason: `The last comment is by ${last ?? "an unknown author"}, not ${asLogin}; reply or let the reviewer resolve it.`,
        };
      }

      if (!app) {
        throw new PortError(
          "forbidden",
          "Resolving review threads needs this container's own GitHub App.",
        );
      }

      if (stripBot(asLogin).toLowerCase() !== (await app.slug()).toLowerCase()) {
        throw new PortError(
          "forbidden",
          `Only ${await app.slug()}[bot] can resolve threads from this container, not ${asLogin}.`,
        );
      }

      await http.graphql(
        (await app.token(repo, { repositories: [repo.name], permissions: PERMISSIONS.write }))
          .token,
        RESOLVE_MUTATION,
        { id: threadId },
      );

      return { resolved: true };
    },

    async submitReview(repo, number, review) {
      const { token, app } = await actingToken(repo, "read", REVIEW_PERMISSIONS);
      const pull = (
        await http.request<RestPull>("GET", `${repoPath(repo)}/pulls/${number}`, { token })
      ).data;

      const me = (await app.slug()).toLowerCase();
      if (stripBot(pull.user?.login ?? "").toLowerCase() === me) {
        throw new PortError(
          "forbidden",
          `${self} cannot review their own pull request ${repo.owner}/${repo.name}#${number}.`,
        );
      }

      await http.request("POST", `${repoPath(repo)}/pulls/${number}/reviews`, {
        token,
        body: {
          event: REVIEW_EVENTS[review.verdict],
          body: review.body,
          ...(review.comments?.length
            ? {
                comments: review.comments.map((c) => ({
                  path: c.path,
                  line: c.line,
                  side: "RIGHT",
                  body: c.body,
                })),
              }
            : {}),
        },
      });
    },

    async replyToThread(repo, number, threadId, body) {
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      const nodes = await threadNodes(repo, number, token);
      if (!nodes.some((n) => n.id === threadId)) {
        throw new PortError(
          "not_found",
          `Review thread ${threadId} is not on ${repo.owner}/${repo.name}#${number}.`,
        );
      }

      await http.graphql(token, REPLY_MUTATION, { id: threadId, body });
    },
  };
}
