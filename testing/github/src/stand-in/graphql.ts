import type { RequiredChecksData, ThreadsData } from "@outstaff/integration.vcs.github";
import type { Route, StandInRequest } from "@outstaff/testing.http";
import { headSha, nextSeq, pullOf, toNode } from "./model.js";
import type { GithubAuth, GithubStore } from "./types.js";

type Vars = Record<string, any>; // oxlint-disable-line no-explicit-any

/** One kind of query or mutation: recognised by its text, answered from the variables. */
interface Operation {
  when: (query: string) => boolean;
  run: (s: GithubStore, vars: Vars, query: string, actor: string) => unknown;
}

const page = { hasNextPage: false, endCursor: null };

function threadsOf(s: GithubStore, vars: Vars) {
  const nodes = [...s.threads.values()].filter((t) => t.prNumber === vars["number"]).map(toNode);
  const data: ThreadsData = {
    repository: { pullRequest: { reviewThreads: { pageInfo: page, nodes } } },
  };

  return { data };
}

function reply(s: GithubStore, vars: Vars, _query: string, actor: string) {
  const t = s.threads.get(vars["id"]);
  if (!t) {
    return { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node" }] };
  }

  t.comments.push({
    id: `${t.id}_c${t.comments.length}`,
    databaseId: ++s.counters.comment,
    seq: nextSeq(s),
    author: actor,
    body: vars["body"],
  });

  return { data: { addPullRequestReviewThreadReply: { comment: { id: t.id } } } };
}

function setDraft(s: GithubStore, vars: Vars, query: string) {
  const pr = pullOf(s, String(vars["id"]).slice("PR_".length));
  if (pr) {
    pr.draft = query.includes("convertPullRequestToDraft");
  }

  return { data: { pullRequest: { id: vars["id"], isDraft: pr?.draft ?? false } } };
}

async function requiredChecks(s: GithubStore, vars: Vars) {
  const pr = pullOf(s, vars["number"]);
  const runs = pr ? (s.checks.get(await headSha(s, pr)) ?? []) : [];
  const nodes = runs.map((c) => ({
    __typename: "CheckRun" as const,
    name: c.name,
    status: c.status.toUpperCase(),
    conclusion: c.conclusion?.toUpperCase() ?? null,
    detailsUrl: null,
    isRequired: pr?.required?.has(c.name) ?? false,
  }));

  const data: RequiredChecksData = {
    repository: {
      pullRequest: {
        commits: {
          nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: page, nodes } } } }],
        },
      },
    },
  };

  return { data };
}

function resolve(s: GithubStore, vars: Vars) {
  const t = s.threads.get(vars["id"]);
  if (t) {
    t.resolved = true;
  }

  return { data: { resolveReviewThread: { thread: { id: vars["id"], isResolved: true } } } };
}

/** A thread with only its last comment: who spoke last. */
function lastWord(s: GithubStore, vars: Vars) {
  const t = s.threads.get(vars["id"]);
  const node = t ? toNode(t) : undefined;
  return {
    data: { node: node ? { ...node, comments: { nodes: node.comments.nodes.slice(-1) } } : null },
  };
}

/** In order: the first operation whose text matches answers; the last one matches anything. */
const OPERATIONS: Operation[] = [
  { when: (q) => q.includes("reviewThreads("), run: threadsOf },
  { when: (q) => q.includes("addPullRequestReviewThreadReply"), run: reply },
  {
    when: (q) =>
      /PullRequestForReview|markPullRequestReadyForReview|convertPullRequestToDraft/.test(q),
    run: setDraft,
  },
  { when: (q) => q.includes("statusCheckRollup"), run: requiredChecks },
  {
    when: (q) => q.includes("mergeQueue("),
    run: (s) => ({
      data: { repository: { mergeQueue: s.mergeSettings.queue ? { id: "MQ_1" } : null } },
    }),
  },
  { when: (q) => q.startsWith("mutation"), run: resolve },
  { when: () => true, run: lastWord },
];

/** The GraphQL endpoint: review threads, replies, draft state, required checks, the merge queue, resolving. */
export function graphqlRoute(s: GithubStore, auth: GithubAuth, path: string): Route {
  return {
    method: "POST",
    path,
    handler: (r: StandInRequest) => {
      const { query, variables } = r.json as { query: string; variables: Vars };
      const op = OPERATIONS.find((o) => o.when(query))!;
      return op.run(s, variables, query, auth.actorOf(r) ?? "unknown");
    },
  };
}
