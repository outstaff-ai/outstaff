import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TeamConfig } from "@outstaff/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REPO,
  appRoutes,
  build,
  expectPortError,
  officeSecrets,
  ownSecrets,
  team,
} from "../testing/harness.js";
import type { Route } from "../testing/http-stub.js";
import { testKey } from "../testing/keys.js";

afterEach(() => {
  vi.useRealTimers();
});

const PR = "/repos/acme/app/pulls/1";

const pull = (over: Record<string, unknown> = {}) => ({
  number: 1,
  node_id: "PR_1",
  title: "Add widget",
  body: "details",
  user: { login: "marcus" },
  head: { ref: "feat/widget", sha: "abc123" },
  base: { ref: "main" },
  state: "open",
  draft: false,
  mergeable: true,
  mergeable_state: "clean",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

const get = (path: string, body: unknown): Route => ({
  method: "GET",
  path,
  handler: () => body,
});

const graphql = (answer: (query: string, variables: Record<string, any>) => unknown): Route => ({
  method: "POST",
  path: "/graphql",
  handler: (r) => ({ data: answer(String(r.json.query), r.json.variables) }),
});

/** sam's container: the office App plus sam's own App (installation 8), able to write to acme/app. */
const agent = {
  ...officeSecrets,
  ...ownSecrets,
  GH_APP_SLUG: "acme-sam",
  GH_APP_INSTALLATION_ID: "8",
  OUTSTAFF_PERSON: "sam",
};

const agentRoutes = (extra: Route[] = [], ownToken?: Route["handler"]): Route[] => [
  ...appRoutes(),
  {
    method: "POST",
    path: "/app/installations/8/access_tokens",
    handler:
      ownToken ??
      (() => ({ status: 201, body: { token: "ghs_own", expires_at: "2026-01-01T01:00:00Z" } })),
  },
  ...extra,
];

describe("default clock for the mergeable backoff", () => {
  it("waits on real timers, then rereads the pull request", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const { vcs, stub } = build(
      [
        ...appRoutes(),
        { method: "GET", path: PR, handler: () => pull({ mergeable: ++reads > 1 ? true : null }) },
      ],
      officeSecrets,
      { sleep: undefined as never },
    );

    const result = vcs.getPullRequest(REPO, 1, { waitForMergeable: true });
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toMatchObject({ mergeable: "clean" });
    expect(stub.called("GET", PR)).toHaveLength(2);
  });
});

describe("team repositories", () => {
  it("skips a team repository whose URL cannot be parsed when looking up grants", async () => {
    const withBadRepo = {
      ...team,
      repos: [{ name: "broken", url: "not a url", kind: "other" }, ...team.repos],
    } as unknown as TeamConfig;

    const { vcs } = build(
      appRoutes(),
      agent,
      {},
      undefined,
      { apiUrl: "https://api.github.test" },
      withBadRepo,
    );

    await expect(vcs.credentials("noor", REPO, "read")).resolves.toMatchObject({
      token: "ghs_1",
    });
  });
});

describe("credentials of the apps", () => {
  it("is invalid when an App id is set without any private key", async () => {
    const { vcs } = build(appRoutes(), { GH_OFFICE_APP_ID: "100" });
    const e = await expectPortError(vcs.getPullRequest(REPO, 1), "invalid");
    expect(e.message).toContain("GH_OFFICE_APP_PRIVATE_KEY_FILE");
  });

  const { GH_APP_PRIVATE_KEY: _inline, ...ownWithoutInlineKey } = agent;

  it("reads own and office keys from files without masking them as inline secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-keys-"));
    const file = join(dir, "own.pem");
    writeFileSync(file, testKey.privateKey);
    const { vcs } = build(
      agentRoutes([
        get("/repos/acme/app/actions/jobs/42", {
          steps: [{ name: "build", conclusion: "failure" }],
        }),
        {
          method: "GET",
          path: "/repos/acme/app/actions/jobs/42/logs",
          handler: () => ({ text: "##[group]build\n##[error]boom" }),
        },
      ]),
      { ...ownWithoutInlineKey, GH_APP_PRIVATE_KEY_FILE: file },
    );

    const out = await vcs.checkLog!(REPO, "42");
    expect(out.failedSteps).toEqual([{ name: "build", lines: ["##[error]boom"], omitted: 0 }]);
  });
});

describe("tokens that GitHub will not issue", () => {
  const refuse =
    (status: number): Route["handler"] =>
    () => ({
      status,
      body: { message: "nope" },
    });

  it.each([
    [404, "forbidden"],
    [422, "forbidden"],
    [500, "unavailable"],
  ] as const)("maps a %s for write credentials to %s", async (status, code) => {
    expect.hasAssertions();
    const { vcs } = build(agentRoutes([], refuse(status)), agent);
    await expectPortError(vcs.credentials("sam", REPO, "write"), code);
  });

  it.each([
    [404, "forbidden"],
    [422, "forbidden"],
    [500, "unavailable"],
  ] as const)("maps a %s for an acting token to %s", async (status, code) => {
    expect.hasAssertions();
    const { vcs } = build(agentRoutes([], refuse(status)), agent);
    await expectPortError(vcs.mergePullRequest!(REPO, 1, { method: "merge", sha: "abc" }), code);
  });

  it("says write credentials come from the agent's own container, even when no one is named", async () => {
    const { vcs } = build(appRoutes(), officeSecrets);
    const e = await expectPortError(vcs.credentials("sam", REPO, "write"), "forbidden");
    expect(e.message).toContain("issued to an agent");
  });

  it("names the container when a diff is asked for outside any person", async () => {
    const { vcs } = build(appRoutes(), officeSecrets);
    const e = await expectPortError(vcs.diff(REPO, 1), "forbidden");
    expect(e.message).toContain("this container");
  });
});

describe("listing pull requests by author", () => {
  it("matches the author or its bot login, case-insensitively, and skips ghosts", async () => {
    const { vcs } = build([
      ...appRoutes(),
      get("/repos/acme/app/pulls", [
        pull({ number: 1, user: { login: "Sam" } }),
        pull({ number: 2, user: { login: "sam[bot]" } }),
        pull({ number: 3, user: null }),
        pull({ number: 4, user: { login: "noor" } }),
      ]),
    ]);

    const found = await vcs.listPullRequests(REPO, { author: "SAM" });
    expect(found.map((p) => p.number)).toEqual([1, 2]);
    expect(await vcs.listPullRequests(REPO)).toHaveLength(4);
  });
});

describe("check logs edge cases", () => {
  const logRoutes = (job: unknown, logs: Route["handler"]) =>
    agentRoutes([
      get("/app/installations/8", {}),
      { method: "GET", path: "/repos/acme/app/actions/jobs/42", handler: () => job },
      { method: "GET", path: "/repos/acme/app/actions/jobs/42/logs", handler: logs },
    ]);

  it("reports no failed step when the job lists no steps and the log has no error", async () => {
    const { vcs } = build(
      logRoutes({}, () => ({ text: "one\ntwo" })),
      agent,
    );

    await expect(vcs.checkLog!(REPO, "42")).resolves.toEqual({ failedSteps: [] });
  });

  it("passes other failures through untouched", async () => {
    expect.hasAssertions();
    const { vcs } = build(
      logRoutes({ status: 404, body: { message: "gone" } }, () => ({ text: "" })),
      agent,
    );

    await expectPortError(vcs.checkLog!(REPO, "42"), "not_found");
  });
});

describe("conversation and review mapping of missing fields", () => {
  it("shows ghost authors and empty bodies for deleted users and bodiless entries", async () => {
    const { vcs } = build([
      ...appRoutes(),
      get("/repos/acme/app/issues/1/comments", [
        {
          id: 1,
          user: null,
          body: null,
          created_at: "2026-01-01T00:00:01Z",
          html_url: "https://h/c1",
        },
      ]),
      get("/repos/acme/app/pulls/1/reviews", [
        {
          id: 2,
          user: null,
          body: null,
          state: "APPROVED",
          submitted_at: "2026-01-01T00:00:02Z",
          html_url: "https://h/r2",
        },
      ]),
    ]);

    await expect(vcs.conversation(REPO, 1)).resolves.toEqual([
      {
        id: "comment-1",
        kind: "comment",
        author: "ghost",
        at: "2026-01-01T00:00:01Z",
        url: "https://h/c1",
        body: "",
      },
      {
        id: "review-2",
        kind: "review",
        author: "ghost",
        at: "2026-01-01T00:00:02Z",
        url: "https://h/r2",
        body: "",
        state: "approved",
      },
    ]);
  });

  it("attributes a thread comment without an author to ghost", async () => {
    const { vcs } = build([
      ...appRoutes(),
      graphql(() => ({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "T1",
                  isResolved: false,
                  path: "a.ts",
                  line: null,
                  originalLine: 4,
                  comments: { nodes: [{ id: "C1", databaseId: 1, body: "hi", author: null }] },
                },
              ],
            },
          },
        },
      })),
    ]);

    await expect(vcs.reviewThreads(REPO, 1)).resolves.toEqual([
      {
        id: "T1",
        resolved: false,
        path: "a.ts",
        line: 4,
        comments: [{ id: "C1", author: "ghost", body: "hi" }],
      },
    ]);
  });
});

describe("review comments", () => {
  const threads = (databaseId: number | null) =>
    graphql(() => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "T9",
                isResolved: false,
                path: "a.ts",
                line: null,
                originalLine: null,
                comments: { nodes: [{ id: "C", databaseId, body: "x", author: null }] },
              },
            ],
          },
        },
      },
    }));

  it("returns nothing, and reads no threads, for a review without comments", async () => {
    const { vcs, stub } = build([
      ...appRoutes(),
      get("/repos/acme/app/pulls/1/reviews/5/comments", []),
    ]);

    await expect(vcs.reviewComments!(REPO, 1, "5")).resolves.toEqual([]);
    expect(stub.called("POST", "/graphql")).toHaveLength(0);
  });

  it("leaves out the line, url and thread that GitHub does not give", async () => {
    const { vcs } = build([
      ...appRoutes(),
      get("/repos/acme/app/pulls/1/reviews/5/comments", [
        { id: 10, path: "a.ts", body: "no anchor" },
        {
          id: 11,
          path: "b.ts",
          line: null,
          original_line: 7,
          body: "outdated",
          html_url: "https://h/11",
        },
      ]),
      threads(null),
    ]);

    await expect(vcs.reviewComments!(REPO, 1, "5")).resolves.toEqual([
      { id: "10", path: "a.ts", body: "no anchor" },
      { id: "11", path: "b.ts", line: 7, body: "outdated", url: "https://h/11" },
    ]);
  });

  it("links a comment to the thread that holds it", async () => {
    const { vcs } = build([
      ...appRoutes(),
      get("/repos/acme/app/pulls/1/reviews/5/comments", [{ id: 10, path: "a.ts", body: "b" }]),
      threads(10),
    ]);

    await expect(vcs.reviewComments!(REPO, 1, "5")).resolves.toMatchObject([
      { id: "10", threadId: "T9" },
    ]);
  });
});

describe("updating drafts and reviewing", () => {
  it("is unavailable when GitHub gives no node id to change the draft state with", async () => {
    const { vcs, stub } = build(
      agentRoutes([get(PR, pull({ node_id: undefined, draft: true }))]),
      agent,
    );

    await expectPortError(vcs.updatePullRequest(REPO, 1, { draft: false }), "unavailable");
    expect(stub.called("POST", "/graphql")).toHaveLength(0);
  });

  it("lets a review go ahead on a pull request whose author was deleted", async () => {
    const { vcs, stub } = build(
      agentRoutes([
        get(PR, pull({ user: null })),
        { method: "POST", path: `${PR}/reviews`, handler: () => ({}) },
      ]),
      agent,
    );

    await vcs.submitReview!(REPO, 1, { verdict: "comment", body: "ok" });
    expect(stub.called("POST", `${PR}/reviews`)).toHaveLength(1);
  });
});

describe("review state", () => {
  const review = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    user: { login: "noor" },
    body: "",
    state: "APPROVED",
    submitted_at: "2026-01-01T00:00:10Z",
    commit_id: "c0ffee",
    html_url: "https://h/r",
    ...over,
  });

  it("orders submitted reviews by time and skips pending, unknown and unsubmitted ones", async () => {
    const { vcs } = build([
      ...appRoutes(),
      get("/repos/acme/app/pulls/1/reviews", [
        review(3, { submitted_at: "2026-01-01T00:00:30Z", user: null, commit_id: null }),
        review(1, { submitted_at: "2026-01-01T00:00:10Z", state: "CHANGES_REQUESTED" }),
        review(2, { submitted_at: "2026-01-01T00:00:20Z", state: "DISMISSED" }),
        review(4, { state: "PENDING" }),
        review(5, { submitted_at: null }),
      ]),
      get(PR, pull({ requested_reviewers: null })),
    ]);

    await expect(vcs.reviewState!(REPO, 1)).resolves.toEqual({
      reviews: [
        {
          id: "1",
          author: "noor",
          state: "changes_requested",
          at: "2026-01-01T00:00:10Z",
          commitSha: "c0ffee",
        },
        {
          id: "2",
          author: "noor",
          state: "dismissed",
          at: "2026-01-01T00:00:20Z",
          commitSha: "c0ffee",
        },
        { id: "3", author: "ghost", state: "approved", at: "2026-01-01T00:00:30Z" },
      ],
      requestedReviewers: [],
    });
  });
});

describe("required checks", () => {
  const rollup = (contexts: unknown) => ({
    repository: {
      pullRequest: {
        commits: {
          nodes: [{ commit: { statusCheckRollup: contexts === null ? null : { contexts } } }],
        },
      },
    },
  });

  const run = (name: string, over: Record<string, unknown> = {}) => ({
    __typename: "CheckRun",
    name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
    detailsUrl: `https://ci/${name}`,
    isRequired: true,
    ...over,
  });

  it("is not found when the pull request does not exist", async () => {
    expect.hasAssertions();
    const { vcs } = build([...appRoutes(), graphql(() => ({ repository: { pullRequest: null } }))]);
    await expectPortError(vcs.requiredChecks!(REPO, 1), "not_found");
  });

  it("is empty when the head commit has no checks yet", async () => {
    const { vcs } = build([...appRoutes(), graphql(() => rollup(null))]);
    await expect(vcs.requiredChecks!(REPO, 1)).resolves.toEqual([]);
  });

  it("keeps required checks only, mapping check runs and commit statuses, with the pull request as fallback link", async () => {
    const { vcs } = build([
      ...appRoutes(),
      graphql(() =>
        rollup({
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            run("lint", { conclusion: null, status: "IN_PROGRESS", detailsUrl: null }),
            run("optional", { isRequired: false }),
            {
              __typename: "StatusContext",
              context: "legacy",
              state: "FAILURE",
              targetUrl: null,
              isRequired: true,
            },
            {
              __typename: "StatusContext",
              context: "deploy",
              state: "SUCCESS",
              targetUrl: "https://d",
              isRequired: true,
            },
          ],
        }),
      ),
    ]);

    await expect(vcs.requiredChecks!(REPO, 1)).resolves.toEqual([
      { name: "lint", status: "pending", url: "https://github.com/acme/app/pull/1" },
      { name: "legacy", status: "failure", url: "https://github.com/acme/app/pull/1" },
      { name: "deploy", status: "success", url: "https://d" },
    ]);
  });

  it("follows the cursor through every page", async () => {
    const afters: unknown[] = [];
    const { vcs } = build([
      ...appRoutes(),
      graphql((_q, variables) => {
        afters.push(variables["after"]);
        return variables["after"] === null
          ? rollup({ pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [run("a")] })
          : rollup({ pageInfo: { hasNextPage: false, endCursor: null }, nodes: [run("b")] });
      }),
    ]);

    const checks = await vcs.requiredChecks!(REPO, 1);
    expect(checks.map((c) => c.name)).toEqual(["a", "b"]);
    expect(afters).toEqual([null, "C1"]);
  });
});

describe("merge options and permission", () => {
  it("leaves out the methods the repository forbids", async () => {
    const { vcs } = build([
      ...appRoutes(),
      get("/repos/acme/app", { allow_merge_commit: false, allow_squash_merge: false }),
      graphql(() => ({ repository: { mergeQueue: null } })),
    ]);

    await expect(vcs.mergeOptions!(REPO, "main")).resolves.toEqual({ queue: false, methods: [] });
  });

  it("offers each method the repository allows, and the queue when the branch has one", async () => {
    const options = async (info: object, queue: unknown) =>
      build([
        ...appRoutes(),
        get("/repos/acme/app", info),
        graphql(() => ({ repository: { mergeQueue: queue } })),
      ]).vcs.mergeOptions!(REPO, "main");

    await expect(options({ allow_merge_commit: false }, { id: "Q" })).resolves.toEqual({
      queue: true,
      methods: ["squash"],
    });

    await expect(options({ allow_squash_merge: false }, null)).resolves.toEqual({
      queue: false,
      methods: ["merge"],
    });

    await expect(options({}, null)).resolves.toEqual({
      queue: false,
      methods: ["merge", "squash"],
    });
  });

  it("passes failures other than an unknown user through", async () => {
    expect.hasAssertions();
    const { vcs } = build([
      ...appRoutes(),
      get("/repos/acme/app/collaborators/noor/permission", {
        status: 500,
        body: { message: "down" },
      }),
    ]);

    await expectPortError(vcs.permission(REPO, "noor"), "unavailable");
  });
});

describe("events edge cases", () => {
  const ev = (id: string, at: string, over: Record<string, unknown> = {}) => ({
    id,
    type: "IssueCommentEvent",
    actor: { login: "noor" },
    created_at: at,
    payload: {
      action: "created",
      issue: { number: 4, pull_request: {} },
      comment: { id: Number(id), body: `c${id}` },
    },
    ...over,
  });

  const feed = (events: unknown[], headers: Record<string, string> = {}): Route => ({
    method: "GET",
    path: "/repos/acme/app/events",
    handler: () => ({ headers, body: events }),
  });

  const SINCE = JSON.stringify({ "acme/app": { since: "2026-01-01T00:00:00Z" } });

  it("breaks ties between events of the same second by event id", async () => {
    const at = "2026-01-01T00:01:00Z";
    const { vcs } = build([
      ...appRoutes(),
      feed([ev("30", at), ev("10", at), ev("20", at), ev("20", at)]),
    ]);

    const page = await vcs.events([REPO], SINCE);
    expect(page.events.map((e) => e.externalId)).toEqual(["10", "20", "20", "30"]);
  });

  it("baselines an empty first feed at the current time, without an etag", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-03T04:05:06Z"));
    const { vcs } = build([...appRoutes(), feed([])]);
    const page = await vcs.events([REPO], "{}");
    expect(JSON.parse(page.cursor)).toEqual({ "acme/app": { since: "2026-02-03T04:05:06.000Z" } });
    expect(page.events).toEqual([]);
  });

  it("keeps the stored etag when the feed sends none", async () => {
    const cursor = JSON.stringify({
      "acme/app": { since: "2026-01-01T00:00:00Z", etag: 'W/"old"' },
    });

    const { vcs } = build([...appRoutes(), feed([ev("1", "2026-01-01T00:00:05Z")])]);
    const page = await vcs.events([REPO], cursor);
    expect(JSON.parse(page.cursor)["acme/app"].etag).toBe('W/"old"');
  });
});
