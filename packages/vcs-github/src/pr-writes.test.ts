import { describe, expect, it } from "vitest";
import {
  REPO,
  appRoutes,
  build,
  expectPortError,
  officeSecrets,
  ownSecrets,
} from "./testing/harness.js";
import type { Route } from "./testing/http-stub.js";

const own = (person: string) => ({
  ...officeSecrets,
  ...ownSecrets,
  GH_APP_SLUG: person,
  GH_APP_INSTALLATION_ID: "8",
  OUTSTAFF_PERSON: person,
});

const pull = (over: Record<string, unknown> = {}) => ({
  number: 7,
  node_id: "PR_node7",
  title: "Add widget",
  body: "",
  user: { login: "ines[bot]" },
  head: { ref: "feat/widget", sha: "abc123" },
  base: { ref: "main" },
  state: "open",
  draft: false,
  mergeable: null,
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

interface Seen {
  tokenRequests: unknown[];
  bodies: Record<string, unknown>;
  auth: Record<string, string>;
  accept: string[];
  graphql: { query: string; variables: Record<string, unknown> }[];
}

function setup(person: string, over: { pull?: Record<string, unknown>; threads?: string[] } = {}) {
  const seen: Seen = { tokenRequests: [], bodies: {}, auth: {}, accept: [], graphql: [] };
  const routes: Route[] = [
    ...appRoutes(),
    {
      method: "POST",
      path: "/app/installations/8/access_tokens",
      handler: (r) => {
        seen.tokenRequests.push(r.json);
        return { status: 201, body: { token: "ghs_own", expires_at: "2026-01-01T01:00:00Z" } };
      },
    },
    { method: "GET", path: "/repos/acme/app", handler: () => ({ default_branch: "main" }) },
    {
      method: "POST",
      path: "/repos/acme/app/pulls",
      handler: (r) => {
        seen.bodies["open"] = r.json;
        seen.auth["open"] = r.headers.get("authorization")!;
        return {
          status: 201,
          body: pull({
            ...r.json,
            head: { ref: r.json.head, sha: "d00d" },
            base: { ref: r.json.base },
          }),
        };
      },
    },
    {
      method: "GET",
      path: "/repos/acme/app/pulls/7",
      handler: (r) => {
        seen.accept.push(r.headers.get("accept")!);
        seen.auth["get"] = r.headers.get("authorization")!;
        return r.headers.get("accept") === "application/vnd.github.diff"
          ? { text: "diff --git a/x b/x\n" }
          : pull(over.pull);
      },
    },
    {
      method: "PATCH",
      path: "/repos/acme/app/pulls/7",
      handler: (r) => {
        seen.bodies["patch"] = r.json;
        return pull(r.json);
      },
    },
    {
      method: "POST",
      path: "/repos/acme/app/pulls/7/reviews",
      handler: (r) => {
        seen.bodies["review"] = r.json;
        seen.auth["review"] = r.headers.get("authorization")!;
        return {};
      },
    },
    {
      method: "POST",
      path: "/repos/acme/app/issues/7/comments",
      handler: (r) => {
        seen.bodies["comment"] = r.json;
        seen.auth["comment"] = r.headers.get("authorization")!;
        return {};
      },
    },
    {
      method: "POST",
      path: "/graphql",
      handler: (r) => {
        const { query, variables } = r.json;
        if (String(query).startsWith("mutation")) {
          seen.graphql.push({ query, variables });
          return { data: { ok: {} } };
        }

        return {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: (over.threads ?? ["PRRT_1"]).map((id) => ({
                    id,
                    isResolved: false,
                    path: null,
                    line: null,
                    originalLine: null,
                    comments: { nodes: [] },
                  })),
                },
              },
            },
          },
        };
      },
    },
  ];

  return { ...build(routes, own(person)), seen };
}

describe("opening and updating pull requests", () => {
  it("opens as the person's own App, defaulting base to the default branch, as a draft on request", async () => {
    const { vcs, seen } = setup("sam");
    const pr = await vcs.openPullRequest(REPO, {
      head: "feat/widget",
      title: "Add widget",
      body: "Closes #1",
      draft: true,
    });

    expect(seen.bodies["open"]).toEqual({
      head: "feat/widget",
      base: "main",
      title: "Add widget",
      body: "Closes #1",
      draft: true,
    });

    expect(seen.auth["open"]).toBe("Bearer ghs_own");
    expect(pr.url).toBe("https://github.com/acme/app/pull/7");
  });

  it("refuses a head equal to the default branch without creating anything", async () => {
    const { vcs, seen } = setup("sam");
    await expectPortError(
      vcs.openPullRequest(REPO, { head: "main", title: "t", body: "" }),
      "invalid",
    );

    await expectPortError(
      vcs.openPullRequest(REPO, { head: "acme:main", title: "t", body: "" }),
      "invalid",
    );

    expect(seen.bodies["open"]).toBeUndefined();
  });

  it("patches title, body and base, and changes draft state through GraphQL", async () => {
    const { vcs, seen } = setup("sam");
    await vcs.updatePullRequest(REPO, 7, { title: "New", base: "release" });
    expect(seen.bodies["patch"]).toEqual({ title: "New", base: "release" });
    const draft = await vcs.updatePullRequest(REPO, 7, { draft: true });
    expect(draft.draft).toBe(true);
    expect(seen.graphql).toMatchObject([
      {
        query: expect.stringContaining("convertPullRequestToDraft"),
        variables: { id: "PR_node7" },
      },
    ]);
  });

  it("leaves draft state alone when it already matches", async () => {
    const { vcs, seen } = setup("sam", { pull: { draft: true } });
    await vcs.updatePullRequest(REPO, 7, { draft: true });
    expect(seen.graphql).toEqual([]);
    await vcs.updatePullRequest(REPO, 7, { draft: false });
    expect(seen.graphql[0]?.query).toContain("markPullRequestReadyForReview");
  });

  it.each(["noor", "lee"])(
    "refuses opening, updating and replying for %s, who has no write grant",
    async (person) => {
      const { vcs, seen } = setup(person);
      await expectPortError(
        vcs.openPullRequest(REPO, { head: "feat/x", title: "t", body: "" }),
        "forbidden",
      );

      await expectPortError(vcs.updatePullRequest(REPO, 7, { title: "t" }), "forbidden");
      await expectPortError(vcs.replyToThread(REPO, 7, "PRRT_1", "ok"), "forbidden");
      await expectPortError(vcs.commentOnPullRequest(REPO, 7, "ok"), "forbidden");
      expect(seen.tokenRequests).toEqual([]);
      expect(seen.bodies).toEqual({});
    },
  );

  it("refuses writes in a container without its own App", async () => {
    expect.hasAssertions();
    const { vcs } = build([...appRoutes()], { ...officeSecrets, OUTSTAFF_PERSON: "sam" });
    await expectPortError(
      vcs.openPullRequest(REPO, { head: "feat/x", title: "t", body: "" }),
      "forbidden",
    );
  });

  it("is forbidden when GitHub will not grant the App write access", async () => {
    expect.hasAssertions();
    const { vcs } = build(
      [
        ...appRoutes(),
        {
          method: "POST",
          path: "/app/installations/8/access_tokens",
          handler: () => ({ status: 422, body: { message: "permissions not granted" } }),
        },
      ],
      own("sam"),
    );

    await expectPortError(
      vcs.openPullRequest(REPO, { head: "feat/x", title: "t", body: "" }),
      "forbidden",
    );
  });
});

describe("reviews, replies and diffs", () => {
  it("submits a review with inline comments, needing only pull request access", async () => {
    const { vcs, seen } = setup("noor");
    await vcs.submitReview(REPO, 7, {
      verdict: "request_changes",
      body: "Needs work",
      comments: [{ path: "src/a.ts", line: 3, body: "rename" }],
    });

    expect(seen.bodies["review"]).toEqual({
      event: "REQUEST_CHANGES",
      body: "Needs work",
      comments: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "rename" }],
    });

    expect(seen.tokenRequests).toEqual([
      { repositories: ["app"], permissions: { pull_requests: "write" } },
    ]);

    expect(seen.auth["review"]).toBe("Bearer ghs_own");
  });

  it("maps each verdict to a review event", async () => {
    const { vcs, seen } = setup("kit");
    await vcs.submitReview(REPO, 7, { verdict: "approve", body: "" });
    expect(seen.bodies["review"]).toEqual({ event: "APPROVE", body: "" });
    await vcs.submitReview(REPO, 7, { verdict: "comment", body: "hm" });
    expect(seen.bodies["review"]).toEqual({ event: "COMMENT", body: "hm" });
  });

  it("refuses reviewing one's own pull request and reviewing without any grant", async () => {
    const mine = setup("sam", { pull: { user: { login: "sam[bot]" } } });
    await expectPortError(
      mine.vcs.submitReview(REPO, 7, { verdict: "approve", body: "" }),
      "forbidden",
    );

    expect(mine.seen.bodies["review"]).toBeUndefined();
    const stranger = setup("lee");
    await expectPortError(
      stranger.vcs.submitReview(REPO, 7, { verdict: "approve", body: "" }),
      "forbidden",
    );
  });

  it("replies through GraphQL as the own App, only to a thread of that pull request", async () => {
    const { vcs, seen } = setup("sam");
    await vcs.replyToThread(REPO, 7, "PRRT_1", "done");
    expect(seen.graphql).toMatchObject([
      {
        query: expect.stringContaining("addPullRequestReviewThreadReply"),
        variables: { id: "PRRT_1", body: "done" },
      },
    ]);

    await expectPortError(vcs.replyToThread(REPO, 7, "PRRT_elsewhere", "x"), "not_found");
    expect(seen.graphql).toHaveLength(1);
  });

  it("comments on the conversation as the own App", async () => {
    const { vcs, seen } = setup("sam");
    await vcs.commentOnPullRequest(REPO, 7, "Thanks, done.");
    expect(seen.bodies["comment"]).toEqual({ body: "Thanks, done." });
    expect(seen.auth["comment"]).toBe("Bearer ghs_own");
  });

  it("reads the diff with the diff media type and a read grant", async () => {
    const { vcs, seen } = setup("noor");
    expect(await vcs.diff(REPO, 7)).toBe("diff --git a/x b/x\n");
    expect(seen.accept).toEqual(["application/vnd.github.diff"]);
    expect(seen.auth["get"]).toBe("Bearer ghs_1");
    await expectPortError(setup("lee").vcs.diff(REPO, 7), "forbidden");
  });
});
