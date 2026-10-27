import type { RequiredChecksData, ThreadsData } from "@outstaff/integration.vcs.github";
import type { FakeState, Route } from "../types.js";
import { actorOf, toNode } from "./requests.js";

/** The GraphQL endpoint: review threads, replies, draft state, required checks, the merge queue and resolving. */
export function graphqlRoute(s: FakeState): Route {
  const { counters: n, prs, checks, threads } = s;
  return {
    method: "POST",
    path: "/graphql",
    handler: (r) => {
      const { query, variables } = r.json as { query: string; variables: Record<string, any> }; // oxlint-disable-line no-explicit-any
      if (query.includes("reviewThreads(")) {
        const nodes = [...threads.values()]
          .filter((t) => t.prNumber === variables["number"])
          .map(toNode);

        const data: ThreadsData = {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
            },
          },
        };

        return { data };
      }

      if (query.includes("addPullRequestReviewThreadReply")) {
        const t = threads.get(variables["id"]);
        if (!t) {
          return {
            data: null,
            errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node" }],
          };
        }

        t.comments.push({
          id: `${t.id}_c${t.comments.length}`,
          databaseId: ++n.commentCounter,
          author: `${actorOf(r)}[bot]`,
          body: variables["body"],
        });

        return { data: { addPullRequestReviewThreadReply: { comment: { id: t.id } } } };
      }

      if (
        query.includes("PullRequestForReview") ||
        /markPullRequestReadyForReview|convertPullRequestToDraft/.test(query)
      ) {
        const pr = prs.get(Number(String(variables["id"]).slice("PR_".length)));
        if (pr) {
          pr.draft = query.includes("convertPullRequestToDraft");
        }

        return { data: { pullRequest: { id: variables["id"], isDraft: pr?.draft ?? false } } };
      }

      if (query.includes("statusCheckRollup")) {
        const pr = prs.get(variables["number"]);
        const data: RequiredChecksData = {
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: (pr ? (checks.get(pr.head.sha) ?? []) : []).map((c) => ({
                            __typename: "CheckRun",
                            name: c.name,
                            status: c.status.toUpperCase(),
                            conclusion: c.conclusion?.toUpperCase() ?? null,
                            detailsUrl: null,
                            isRequired: pr?.required?.has(c.name) ?? false,
                          })),
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        };

        return { data };
      }

      if (query.includes("mergeQueue(")) {
        return {
          data: { repository: { mergeQueue: s.mergeSettings.queue ? { id: "MQ_1" } : null } },
        };
      }

      if (query.startsWith("mutation")) {
        const t = threads.get(variables["id"]);
        if (t) {
          t.resolved = true;
        }

        return {
          data: { resolveReviewThread: { thread: { id: variables["id"], isResolved: true } } },
        };
      }

      const t = threads.get(variables["id"]);
      return {
        data: {
          node: t
            ? {
                ...toNode(t),
                comments: {
                  nodes: t.comments.slice(-1).map((c) => ({ author: { login: c.author } })),
                },
              }
            : null,
        },
      };
    },
  };
}
