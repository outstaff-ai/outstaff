import type { RequiredChecksData, RollupContext, ThreadsData } from "../../api.types.js";
import type { FakeState, Route, StoredPull, StubRequest } from "../types.js";
import { actorOf, toNode } from "./requests.js";

type Operation = (s: FakeState, r: StubRequest) => unknown;

function reviewThreads(s: FakeState, r: StubRequest): unknown {
  const nodes = [...s.threads.values()]
    .filter((t) => t.prNumber === r.json.variables["number"])
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

function replyToThread(s: FakeState, r: StubRequest): unknown {
  const { variables } = r.json;
  const t = s.threads.get(variables["id"]);
  if (!t) {
    return {
      data: null,
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node" }],
    };
  }

  t.comments.push({
    id: `${t.id}_c${t.comments.length}`,
    databaseId: ++s.counters.commentCounter,
    author: `${actorOf(r)}[bot]`,
    body: variables["body"],
  });

  return { data: { addPullRequestReviewThreadReply: { comment: { id: t.id } } } };
}

function setDraft(s: FakeState, r: StubRequest): unknown {
  const { query, variables } = r.json;
  const pr = s.prs.get(Number(String(variables["id"]).slice("PR_".length)));
  if (pr) {
    pr.draft = query.includes("convertPullRequestToDraft");
  }

  return { data: { pullRequest: { id: variables["id"], isDraft: pr?.draft ?? false } } };
}

function rollupNodes(s: FakeState, pr: StoredPull | undefined): RollupContext[] {
  if (!pr) {
    return [];
  }

  return (s.checks.get(pr.head.sha) ?? []).map((c) => ({
    __typename: "CheckRun",
    name: c.name,
    status: c.status.toUpperCase(),
    conclusion: c.conclusion?.toUpperCase() ?? null,
    detailsUrl: null,
    isRequired: pr.required?.has(c.name) ?? false,
  }));
}

function statusCheckRollup(s: FakeState, r: StubRequest): unknown {
  const nodes = rollupNodes(s, s.prs.get(r.json.variables["number"]));
  const contexts = { pageInfo: { hasNextPage: false, endCursor: null }, nodes };
  const data: RequiredChecksData = {
    repository: {
      pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] } },
    },
  };

  return { data };
}

function mergeQueue(s: FakeState): unknown {
  return { data: { repository: { mergeQueue: s.mergeSettings.queue ? { id: "MQ_1" } : null } } };
}

function resolveThread(s: FakeState, r: StubRequest): unknown {
  const id = r.json.variables["id"];
  const t = s.threads.get(id);
  if (t) {
    t.resolved = true;
  }

  return { data: { resolveReviewThread: { thread: { id, isResolved: true } } } };
}

function lastComment(s: FakeState, r: StubRequest): unknown {
  const t = s.threads.get(r.json.variables["id"]);
  if (!t) {
    return { data: { node: null } };
  }

  const nodes = t.comments.slice(-1).map((c) => ({ author: { login: c.author } }));
  return { data: { node: { ...toNode(t), comments: { nodes } } } };
}

/** Which operation a query is, checked in order; anything else reads a thread's last comment. */
const OPERATIONS: [(query: string) => boolean, Operation][] = [
  [(q) => q.includes("reviewThreads("), reviewThreads],
  [(q) => q.includes("addPullRequestReviewThreadReply"), replyToThread],
  [
    (q) =>
      q.includes("PullRequestForReview") ||
      /markPullRequestReadyForReview|convertPullRequestToDraft/.test(q),
    setDraft,
  ],
  [(q) => q.includes("statusCheckRollup"), statusCheckRollup],
  [(q) => q.includes("mergeQueue("), mergeQueue],
  [(q) => q.startsWith("mutation"), resolveThread],
];

/** The GraphQL endpoint: review threads, replies, draft state, required checks, the merge queue and resolving. */
export function graphqlRoute(s: FakeState): Route {
  return {
    method: "POST",
    path: "/graphql",
    handler: (r) => {
      const query: string = r.json.query;
      const operation = OPERATIONS.find(([matches]) => matches(query))?.[1] ?? lastComment;
      return operation(s, r);
    },
  };
}
