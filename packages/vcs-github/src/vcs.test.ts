import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortError, silentLogger } from "@outstaff/core";
import { githubOptions } from "./options.js";
import { createGithubVcs } from "./vcs.js";
import {
  secretMap,
  team,
  REPO,
  appRoutes,
  build,
  clock,
  expectPortError,
  officeSecrets,
  ownSecrets,
} from "./testing/harness.js";
import { testKey } from "./testing/keys.js";
import type { Route } from "./testing/http-stub.js";

const pull = (over: Record<string, unknown> = {}) => ({
  number: 1,
  title: "Add widget",
  body: "details",
  user: { login: "sam[bot]" },
  head: { ref: "feat/widget", sha: "abc123" },
  base: { ref: "main" },
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  mergeable_state: "clean",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("app authentication", () => {
  it("derives the installation from the repo owner, signs /app calls with a JWT and repo calls with the installation token", async () => {
    const seen: Record<string, string> = {};
    const routes: Route[] = [
      ...appRoutes(),
      {
        method: "GET",
        path: "/repos/acme/app/pulls/1",
        handler: (r) => {
          seen["pull"] = r.headers.get("authorization")!;
          return pull();
        },
      },
    ];

    const { vcs, stub } = build(routes);
    await vcs.getPullRequest(REPO, 1);
    await vcs.getPullRequest(REPO, 1);
    expect(seen["pull"]).toBe("Bearer ghs_1");
    expect(stub.called("GET", "/app/installations")).toHaveLength(1);
    expect(stub.called("POST", "/app/installations/7/access_tokens")).toHaveLength(1);
    expect(stub.calls[0]!.headers.get("authorization")!.split(".")).toHaveLength(3);
  });

  it("uses GH_OFFICE_APP_INSTALLATION_ID without listing installations, and reads the key from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-key-"));
    const file = join(dir, "app.pem");
    writeFileSync(file, testKey.privateKey);
    const { vcs, stub } = build(
      [...appRoutes(), { method: "GET", path: "/repos/acme/app/pulls/1", handler: () => pull() }],
      {
        GH_OFFICE_APP_ID: "100",
        GH_OFFICE_APP_PRIVATE_KEY_FILE: file,
        GH_OFFICE_APP_INSTALLATION_ID: "7",
      },
    );

    await vcs.getPullRequest(REPO, 1);
    expect(stub.called("GET", "/app/installations")).toHaveLength(0);
  });

  it("accepts a PEM with escaped newlines", async () => {
    const { vcs } = build(
      [...appRoutes(), { method: "GET", path: "/repos/acme/app/pulls/1", handler: () => pull() }],
      {
        GH_OFFICE_APP_ID: "100",
        GH_OFFICE_APP_PRIVATE_KEY: testKey.privateKey.replace(/\n/g, "\\n"),
      },
    );

    await expect(vcs.getPullRequest(REPO, 1)).resolves.toMatchObject({ number: 1 });
  });

  it("refreshes an installation token five minutes before it expires", async () => {
    const c = clock();
    const { vcs, stub } = build(
      [
        ...appRoutes("ghs", 7, "2026-01-01T01:00:00Z"),
        { method: "GET", path: "/repos/acme/app/pulls/1", handler: () => pull() },
      ],
      officeSecrets,
      {},
      c,
    );

    await vcs.getPullRequest(REPO, 1);
    c.advance(54 * 60_000);
    await vcs.getPullRequest(REPO, 1);
    expect(stub.called("POST", "/app/installations/7/access_tokens")).toHaveLength(1);
    c.advance(2 * 60_000);
    await vcs.getPullRequest(REPO, 1);
    expect(stub.called("POST", "/app/installations/7/access_tokens")).toHaveLength(2);
  });

  it("is forbidden when the App is not installed on the owner", async () => {
    expect.hasAssertions();
    const { vcs } = build([
      {
        method: "GET",
        path: "/app/installations",
        handler: () => [{ id: 9, account: { login: "other" } }],
      },
    ]);

    await expectPortError(vcs.getPullRequest(REPO, 1), "forbidden");
  });

  it("is invalid when the office App is not configured", async () => {
    expect.hasAssertions();
    const { vcs } = build([], {});
    await expectPortError(vcs.getPullRequest(REPO, 1), "invalid");
  });
});

describe("credentials", () => {
  const agent = { ...officeSecrets, ...ownSecrets, OUTSTAFF_PERSON: "sam" };
  const routes = (extra: Route[] = []): Route[] => [
    // office App (jwt iss 100) is installation 7, the agent's own App (iss 200) is installation 8
    {
      method: "GET",
      path: "/app/installations",
      handler: (r) => [{ id: appId(r) === 100 ? 7 : 8, account: { login: "acme" } }],
    },
    {
      method: "POST",
      path: "/app/installations/7/access_tokens",
      handler: () => ({
        status: 201,
        body: { token: "ghs_office", expires_at: "2026-01-01T01:00:00Z" },
      }),
    },
    {
      method: "POST",
      path: "/app/installations/8/access_tokens",
      handler: () => ({
        status: 201,
        body: { token: "ghs_sam", expires_at: "2026-01-01T01:00:00Z" },
      }),
    },
    { method: "GET", path: "/app", handler: () => ({ slug: "acme-sam" }) },
    {
      method: "GET",
      path: "/users/:login",
      handler: (r) => ({ id: r.params["login"] === "acme-sam[bot]" ? 4242 : 0 }),
    },
    ...extra,
  ];

  const appId = (r: { headers: Headers }) =>
    Number(
      JSON.parse(
        Buffer.from(r.headers.get("authorization")!.split(".")[1]!, "base64url").toString(),
      ).iss,
    );

  it("hands out read access from the office App, scoped to the repo, for anyone on the team", async () => {
    const { vcs, stub } = build(routes(), agent);
    expect(await vcs.credentials("noor", REPO, "read")).toEqual({
      token: "ghs_office",
      expiresAt: "2026-01-01T01:00:00Z",
    });

    expect(stub.called("POST", "/app/installations/7/access_tokens")[0]!.json).toEqual({
      repositories: ["app"],
      permissions: { contents: "read" },
    });

    expect(stub.called("POST", "/app/installations/8/access_tokens")).toHaveLength(0);
    await expectPortError(vcs.credentials("stranger", REPO, "read"), "forbidden");
  });

  it("mints write access from the agent's own App for itself, with the bot identity", async () => {
    const { vcs, stub } = build(routes(), agent);
    const cred = await vcs.credentials("sam", REPO, "write");
    expect(cred).toEqual({
      token: "ghs_sam",
      expiresAt: "2026-01-01T01:00:00Z",
      author: { name: "acme-sam[bot]", email: "4242+acme-sam[bot]@users.noreply.github.com" },
    });

    expect(stub.called("POST", "/app/installations/8/access_tokens")[0]!.json).toEqual({
      repositories: ["app"],
      permissions: { contents: "write", pull_requests: "write", issues: "write" },
    });

    await vcs.credentials("sam", REPO, "write");
    expect(stub.called("POST", "/app/installations/8/access_tokens")).toHaveLength(1);
  });

  it("gates credentials on grants: none is forbidden, read grants read only, write grants both", async () => {
    const { vcs } = build(routes(), agent);
    await expectPortError(vcs.credentials("lee", REPO, "read"), "forbidden");
    await expectPortError(vcs.credentials("lee", REPO, "write"), "forbidden");
    await expect(vcs.credentials("noor", REPO, "read")).resolves.toMatchObject({
      token: "ghs_office",
    }); // kind:primary

    await expect(vcs.credentials("kit", REPO, "read")).resolves.toMatchObject({
      token: "ghs_office",
    }); // *

    await expectPortError(vcs.credentials("noor", REPO, "write"), "forbidden");
    await expect(vcs.credentials("sam", REPO, "read")).resolves.toBeTruthy();
    await expect(vcs.credentials("sam", REPO, "write")).resolves.toMatchObject({
      token: "ghs_sam",
    });

    await expectPortError(
      vcs.credentials("sam", { owner: "acme", name: "elsewhere" }, "read"),
      "forbidden",
    );
  });

  it("refuses a self whose grant is read-only", async () => {
    expect.hasAssertions();
    const { vcs } = build(routes(), { ...agent, OUTSTAFF_PERSON: "noor" });
    await expectPortError(vcs.credentials("noor", REPO, "write"), "forbidden");
  });

  it("refuses write access for any other person, even with the office App available", async () => {
    const { vcs, stub } = build(routes(), agent);
    await expectPortError(vcs.credentials("noor", REPO, "write"), "forbidden");
    expect(stub.called("POST", "/app/installations/8/access_tokens")).toHaveLength(0);
  });

  it("never mints write tokens in the office container (no own App)", async () => {
    const { vcs, stub } = build(routes(), { ...officeSecrets, OUTSTAFF_PERSON: "sam" });
    await expectPortError(vcs.credentials("sam", REPO, "write"), "forbidden");
    await expectPortError(vcs.credentials("noor", REPO, "write"), "forbidden");
    expect(stub.called("POST", "/app/installations/8/access_tokens")).toHaveLength(0);
    await expect(vcs.credentials("noor", REPO, "read")).resolves.toMatchObject({
      token: "ghs_office",
    });
  });

  it("takes the own App's slug and installation id from secrets instead of deriving them", async () => {
    const { vcs, stub } = build(routes(), {
      ...agent,
      GH_APP_SLUG: "acme-sam",
      GH_APP_INSTALLATION_ID: "8",
    });

    await vcs.credentials("sam", REPO, "write");
    expect(stub.called("GET", "/app")).toHaveLength(0);
    expect(stub.called("GET", "/app/installations").filter((c) => appId(c) === 200)).toHaveLength(
      0,
    );
  });

  it("is forbidden when GitHub will not grant the write permissions", async () => {
    expect.hasAssertions();
    const refusing = routes().map((r) =>
      r.path === "/app/installations/8/access_tokens"
        ? { ...r, handler: () => ({ status: 422, body: { message: "permissions not granted" } }) }
        : r,
    );

    await expectPortError(
      build(refusing, agent).vcs.credentials("sam", REPO, "write"),
      "forbidden",
    );
  });
});

describe("pull requests", () => {
  const base = appRoutes();

  it("lists with pagination, filters by author and maps state, author kind and mergeability", async () => {
    const { vcs, stub } = build([
      ...base,
      {
        method: "GET",
        path: "/repos/acme/app/pulls",
        handler: (r) => {
          expect(r.query.get("state")).toBe("all");
          if (r.query.get("page") === "2") {
            return [
              pull({
                number: 3,
                user: { login: "dependabot[bot]" },
                merged_at: "2026-01-01T00:00:00Z",
                state: "closed",
                mergeable: undefined,
                mergeable_state: undefined,
              }),
            ];
          }

          return {
            headers: {
              link: '<https://api.github.test/repos/acme/app/pulls?state=all&page=2>; rel="next"',
            },
            body: [
              pull({ number: 1, mergeable: undefined, mergeable_state: undefined }),
              pull({
                number: 2,
                user: { login: "noor" },
                draft: true,
                mergeable: false,
                mergeable_state: "dirty",
              }),
            ],
          };
        },
      },
    ]);

    const all = await vcs.listPullRequests(REPO, { state: "all" });
    expect(all.map((p) => [p.number, p.author, p.state, p.draft, p.mergeable])).toEqual([
      [1, { login: "sam[bot]", kind: "agent" }, "open", false, "unknown"],
      [2, { login: "noor", kind: "human" }, "open", true, "conflicting"],
      [3, { login: "dependabot[bot]", kind: "bot" }, "merged", false, "unknown"],
    ]);

    expect(all[0]!.url).toBe("https://github.com/acme/app/pull/1");
    expect(
      (await vcs.listPullRequests(REPO, { state: "all", author: "sam" })).map((p) => p.number),
    ).toEqual([1]);

    expect(stub.called("GET", "/repos/acme/app/pulls")).toHaveLength(4);
  });

  it("lets the caller decide which bots are agents", async () => {
    const { vcs } = build(
      [
        ...base,
        {
          method: "GET",
          path: "/repos/acme/app/pulls/1",
          handler: () => pull({ user: { login: "robo[bot]" } }),
        },
      ],
      officeSecrets,
      { isAgentSlug: (s) => s === "robo" },
    );

    expect((await vcs.getPullRequest(REPO, 1)).author.kind).toBe("agent");
  });

  it("maps mergeable_state to clean | conflicting | unknown", async () => {
    const state = { current: pull() as Record<string, unknown> };
    const { vcs } = build([
      ...base,
      { method: "GET", path: "/repos/acme/app/pulls/1", handler: () => state.current },
    ]);

    const read = async (over: Record<string, unknown>) => {
      state.current = pull(over);
      return (await vcs.getPullRequest(REPO, 1)).mergeable;
    };

    expect(await read({})).toBe("clean");
    expect(await read({ mergeable_state: "unstable" })).toBe("clean");
    expect(await read({ mergeable: false, mergeable_state: "dirty" })).toBe("conflicting");
    expect(await read({ mergeable: null, mergeable_state: "unknown" })).toBe("unknown");
  });

  it("retries a null mergeable with backoff, then gives up after six reads", async () => {
    const sleeps: number[] = [];
    let reads = 0;
    const { vcs } = build(
      [
        ...base,
        {
          method: "GET",
          path: "/repos/acme/app/pulls/1",
          handler: () =>
            ++reads < 3 ? pull({ mergeable: null, mergeable_state: "unknown" }) : pull(),
        },
      ],
      officeSecrets,
      { sleep: async (ms) => void sleeps.push(ms) },
    );

    expect((await vcs.getPullRequest(REPO, 1, { waitForMergeable: true })).mergeable).toBe("clean");
    expect(reads).toBe(3);
    expect(sleeps).toEqual([500, 1000]);

    reads = -100;
    sleeps.length = 0;
    expect((await vcs.getPullRequest(REPO, 1, { waitForMergeable: true })).mergeable).toBe(
      "unknown",
    );

    expect(sleeps).toHaveLength(5);
  });

  it("does not wait when not asked or when the pull request is closed", async () => {
    const sleeps: number[] = [];
    let state = "open";
    const { vcs, stub } = build(
      [
        ...base,
        {
          method: "GET",
          path: "/repos/acme/app/pulls/1",
          handler: () => pull({ mergeable: null, mergeable_state: "unknown", state }),
        },
      ],
      officeSecrets,
      { sleep: async (ms) => void sleeps.push(ms) },
    );

    await vcs.getPullRequest(REPO, 1);
    state = "closed";
    await vcs.getPullRequest(REPO, 1, { waitForMergeable: true });
    expect(sleeps).toEqual([]);
    expect(stub.called("GET", "/repos/acme/app/pulls/1")).toHaveLength(2);
  });
});

describe("checks", () => {
  it("combines check runs and commit statuses", async () => {
    const { vcs } = build([
      ...appRoutes(),
      {
        method: "GET",
        path: "/repos/acme/app/commits/abc/check-runs",
        handler: () => ({
          check_runs: [
            {
              name: "build",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.test/runs/1",
            },
            {
              name: "lint",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.test/runs/2",
            },
            {
              name: "e2e",
              status: "completed",
              conclusion: "timed_out",
              html_url: "https://github.test/runs/3",
            },
            {
              name: "docs",
              status: "completed",
              conclusion: "skipped",
              html_url: null,
              details_url: "https://ci.test/docs",
            },
          ],
        }),
      },
      {
        method: "GET",
        path: "/repos/acme/app/commits/abc/status",
        handler: () => ({
          statuses: [
            { context: "legacy", state: "error", target_url: null },
            { context: "old", state: "pending", target_url: "https://ci.test/old" },
          ],
        }),
      },
    ]);

    expect(await vcs.checks(REPO, "abc")).toEqual([
      { name: "build", status: "success", url: "https://github.test/runs/1" },
      { name: "lint", status: "pending", url: "https://github.test/runs/2" },
      { name: "e2e", status: "failure", url: "https://github.test/runs/3" },
      { name: "docs", status: "neutral", url: "https://ci.test/docs" },
      { name: "legacy", status: "failure", url: "https://github.com/acme/app/commit/abc" },
      { name: "old", status: "pending", url: "https://ci.test/old" },
    ]);
  });
});

describe("review threads", () => {
  const thread = (over: Record<string, unknown> = {}) => ({
    id: "PRRT_1",
    isResolved: false,
    path: "src/a.ts",
    line: 3,
    originalLine: 2,
    comments: {
      nodes: [
        { id: "C1", body: "rename this", author: { login: "noor" } },
        { id: "C2", body: "done", author: { login: "sam" } },
      ],
    },
    ...over,
  });

  const gql = (handler: (query: string, vars: Record<string, any>) => unknown): Route => ({
    // oxlint-disable-line no-explicit-any
    method: "POST",
    path: "/graphql",
    handler: (r) => ({ data: handler(r.json.query, r.json.variables) }),
  });

  it("lists threads with comments across pages", async () => {
    const pages: unknown[] = [];
    const { vcs } = build([
      ...appRoutes(),
      gql((_q, v) => {
        pages.push(v["after"]);
        const first = v["after"] === null;
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: first, endCursor: first ? "cur1" : null },
                nodes: [
                  first
                    ? thread()
                    : thread({
                        id: "PRRT_2",
                        isResolved: true,
                        path: null,
                        line: null,
                        originalLine: null,
                      }),
                ],
              },
            },
          },
        };
      }),
    ]);

    const threads = await vcs.reviewThreads(REPO, 5);
    expect(pages).toEqual([null, "cur1"]);
    expect(threads).toEqual([
      {
        id: "PRRT_1",
        resolved: false,
        path: "src/a.ts",
        line: 3,
        comments: [
          { id: "C1", author: "noor", body: "rename this" },
          { id: "C2", author: "sam", body: "done" },
        ],
      },
      {
        id: "PRRT_2",
        resolved: true,
        comments: [
          { id: "C1", author: "noor", body: "rename this" },
          { id: "C2", author: "sam", body: "done" },
        ],
      },
    ]);
  });

  it("maps a missing pull request to not_found", async () => {
    expect.hasAssertions();
    const { vcs } = build([...appRoutes(), gql(() => ({ repository: { pullRequest: null } }))]);
    await expectPortError(vcs.reviewThreads(REPO, 99), "not_found");
  });

  describe("resolveThread", () => {
    const agent = {
      ...officeSecrets,
      ...ownSecrets,
      GH_APP_SLUG: "sam",
      GH_APP_INSTALLATION_ID: "8",
      OUTSTAFF_PERSON: "sam",
    };

    const setup = (node: unknown, secrets: Record<string, string> = agent) => {
      const mutations: unknown[] = [];
      const auth: string[] = [];
      const routes: Route[] = [
        ...appRoutes(),
        {
          method: "POST",
          path: "/app/installations/8/access_tokens",
          handler: () => ({
            status: 201,
            body: { token: "ghs_own", expires_at: "2026-01-01T01:00:00Z" },
          }),
        },
        {
          method: "POST",
          path: "/graphql",
          handler: (r) => {
            auth.push(r.headers.get("authorization")!);
            if (String(r.json.query).startsWith("mutation")) {
              mutations.push(r.json.variables);
              return {
                data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } },
              };
            }

            return { data: { node } };
          },
        },
      ];

      return { ...build(routes, secrets), mutations, auth };
    };

    const lastBy = (login: string | null, isResolved = false) => ({
      id: "PRRT_1",
      isResolved,
      comments: { nodes: [{ author: login ? { login } : null }] },
    });

    it("refuses when the last comment is someone else's, without sending the mutation", async () => {
      const { vcs, mutations } = setup(lastBy("noor"));
      const res = await vcs.resolveThread(REPO, "PRRT_1", "sam");
      expect(res.resolved).toBe(false);
      expect(res.reason).toContain("noor");
      expect(mutations).toEqual([]);
    });

    it("refuses when the last comment has no author", async () => {
      const { vcs, mutations } = setup(lastBy(null));
      expect((await vcs.resolveThread(REPO, "PRRT_1", "sam")).resolved).toBe(false);
      expect(mutations).toEqual([]);
    });

    it("resolves when the last comment is the caller's, matching an App login with or without [bot]", async () => {
      const { vcs, mutations } = setup(lastBy("sam"));
      expect(await vcs.resolveThread(REPO, "PRRT_1", "sam[bot]")).toEqual({ resolved: true });
      expect(mutations).toEqual([{ id: "PRRT_1" }]);
    });

    it("defaults to the container's own bot login", async () => {
      const own = setup(lastBy("sam"));
      expect(await own.vcs.resolveThread(REPO, "PRRT_1")).toEqual({ resolved: true });
      expect(own.mutations).toEqual([{ id: "PRRT_1" }]);
      const other = setup(lastBy("noor"));
      expect((await other.vcs.resolveThread(REPO, "PRRT_1")).resolved).toBe(false);
      expect(other.mutations).toEqual([]);
      await expectPortError(
        setup(lastBy("sam"), officeSecrets).vcs.resolveThread(REPO, "PRRT_1"),
        "forbidden",
      );
    });

    it("sends the mutation with the container's own App token, not the read-only office token", async () => {
      const { vcs, auth, stub } = setup(lastBy("sam"));
      await vcs.resolveThread(REPO, "PRRT_1", "sam");
      expect(auth).toEqual(["Bearer ghs_1", "Bearer ghs_own"]);
      expect(
        stub.called("POST", "/app/installations/8/access_tokens")[0]!.json.permissions
          .pull_requests,
      ).toBe("write");
    });

    it("is forbidden for a login that is not this container's App, even when it wrote the last comment", async () => {
      const { vcs, mutations } = setup(lastBy("noor"));
      await expectPortError(vcs.resolveThread(REPO, "PRRT_1", "noor"), "forbidden");
      expect(mutations).toEqual([]);
    });

    it("is forbidden in a container without its own App", async () => {
      const { vcs, mutations } = setup(lastBy("sam"), officeSecrets);
      await expectPortError(vcs.resolveThread(REPO, "PRRT_1", "sam"), "forbidden");
      expect(mutations).toEqual([]);
    });

    it("is idempotent for a resolved thread and not_found for an unknown id", async () => {
      const resolved = setup(lastBy("noor", true));
      expect(await resolved.vcs.resolveThread(REPO, "PRRT_1", "sam")).toEqual({ resolved: true });
      expect(resolved.mutations).toEqual([]);
      await expectPortError(setup(null).vcs.resolveThread(REPO, "nope", "sam"), "not_found");
    });
  });
});

describe("permission", () => {
  it("maps collaborator permissions and treats unknown users as none", async () => {
    const { vcs } = build([
      ...appRoutes(),
      {
        method: "GET",
        path: "/repos/acme/app/collaborators/:login/permission",
        handler: (r) => {
          const level: Record<string, string> = {
            noor: "admin",
            sam: "maintain",
            kit: "triage",
            pat: "read",
            lee: "none",
          };

          const login = r.params["login"]!;
          return login in level
            ? { permission: level[login] }
            : { status: 404, body: { message: "Not Found" } };
        },
      },
    ]);

    const levels = await Promise.all(
      ["noor", "sam", "kit", "pat", "lee", "ghost"].map((l) => vcs.permission(REPO, l)),
    );

    expect(levels).toEqual(["admin", "write", "read", "read", "none", "none"]);
  });
});

describe("events", () => {
  const ev = (id: number, type: string, payload: Record<string, unknown>, actor = "noor") => ({
    id: String(id),
    type,
    actor: { login: actor },
    created_at: `2026-01-01T00:00:${String(id % 60).padStart(2, "0")}Z`,
    payload,
  });

  const history = [
    ev(110, "IssueCommentEvent", {
      action: "created",
      issue: { number: 4, pull_request: {} },
      comment: { id: 9, body: "ping" },
    }),
    ev(109, "IssueCommentEvent", {
      action: "created",
      issue: { number: 5 },
      comment: { id: 8, body: "plain issue" },
    }),
    ev(108, "PullRequestReviewCommentEvent", {
      action: "created",
      pull_request: { number: 4 },
      comment: { id: 7, body: "nit", path: "a.ts" },
    }),
    ev(107, "PullRequestReviewEvent", {
      action: "submitted",
      pull_request: { number: 4 },
      review: { id: 6, state: "APPROVED", body: "ok" },
    }),
    ev(
      106,
      "PullRequestEvent",
      { action: "synchronize", number: 4, pull_request: { number: 4, head: { sha: "s2" } } },
      "sam[bot]",
    ),
    ev(105, "PullRequestEvent", {
      action: "closed",
      number: 3,
      pull_request: { number: 3, merged: true },
    }),
    ev(104, "PullRequestEvent", {
      action: "closed",
      number: 2,
      pull_request: { number: 2, merged: false },
    }),
    ev(103, "PullRequestEvent", { action: "reopened", number: 2, pull_request: { number: 2 } }),
    ev(102, "PullRequestEvent", { action: "labeled", number: 2, pull_request: { number: 2 } }),
    ev(
      101,
      "PullRequestEvent",
      {
        action: "opened",
        number: 2,
        pull_request: {
          number: 2,
          title: "T",
          head: { ref: "f", sha: "s1" },
          base: { ref: "main" },
        },
      },
      "sam[bot]",
    ),
    ev(100, "PushEvent", {}),
  ];

  it("normalises events oldest first with actor and a stable external id", async () => {
    const { vcs } = build([
      ...appRoutes(),
      {
        method: "GET",
        path: "/repos/acme/app/events",
        handler: () => ({ headers: { etag: 'W/"v1"' }, body: history }),
      },
    ]);

    const page = await vcs.events([REPO]);
    expect(page.events.map((e) => [e.externalId, e.type, e.number, e.actor])).toEqual([
      ["101", "pr.opened", 2, "sam[bot]"],
      ["103", "pr.opened", 2, "noor"],
      ["104", "pr.closed", 2, "noor"],
      ["105", "pr.merged", 3, "noor"],
      ["106", "pr.synchronize", 4, "sam[bot]"],
      ["107", "pr.review_submitted", 4, "noor"],
      ["108", "pr.comment", 4, "noor"],
      ["110", "pr.comment", 4, "noor"],
    ]);

    expect(page.events[1]!.data).toMatchObject({ reopened: true });
    expect(page.events[5]!.data).toMatchObject({ state: "approved" });
    expect(page.events[0]!.data).toMatchObject({ title: "T", headSha: "s1" });
    expect(JSON.parse(page.cursor)).toEqual({ "acme/app": { etag: 'W/"v1"', lastEventId: "110" } });
  });

  it("sends If-None-Match and treats 304 as no news", async () => {
    let served = 0;
    const { vcs, stub } = build([
      ...appRoutes(),
      {
        method: "GET",
        path: "/repos/acme/app/events",
        handler: (r) => {
          served++;
          if (r.headers.get("if-none-match") === 'W/"v1"') {
            return { status: 304 };
          }

          return { headers: { etag: 'W/"v1"' }, body: history };
        },
      },
    ]);

    const first = await vcs.events([REPO]);
    const again = await vcs.events([REPO], first.cursor);
    expect(again.events).toEqual([]);
    expect(again.cursor).toBe(first.cursor);
    expect(served).toBe(2);
    expect(
      stub.called("GET", "/repos/acme/app/events")[0]!.headers.get("if-none-match"),
    ).toBeNull();
  });

  it("returns only events newer than the cursor and follows pages while they are all new", async () => {
    const newer = [
      ev(113, "IssueCommentEvent", {
        action: "created",
        issue: { number: 4, pull_request: {} },
        comment: { id: 1, body: "c" },
      }),
      ev(112, "PullRequestEvent", {
        action: "closed",
        number: 4,
        pull_request: { number: 4, merged: true },
      }),
    ];

    const older = [
      ev(111, "PullRequestReviewEvent", {
        action: "submitted",
        pull_request: { number: 4 },
        review: { id: 2, state: "COMMENTED" },
      }),
      ...history,
    ];

    const { vcs, stub } = build([
      ...appRoutes(),
      {
        method: "GET",
        path: "/repos/acme/app/events",
        handler: (r) =>
          r.query.get("page") === "2"
            ? { body: older }
            : {
                headers: {
                  etag: 'W/"v2"',
                  link: '<https://api.github.test/repos/acme/app/events?per_page=100&page=2>; rel="next"',
                },
                body: newer,
              },
      },
    ]);

    const cursor = JSON.stringify({ "acme/app": { etag: 'W/"v1"', lastEventId: "110" } });
    const page = await vcs.events([REPO], cursor);
    expect(page.events.map((e) => e.externalId)).toEqual(["111", "112", "113"]);
    expect(JSON.parse(page.cursor)["acme/app"]).toEqual({ etag: 'W/"v2"', lastEventId: "113" });
    expect(stub.called("GET", "/repos/acme/app/events")[0]!.headers.get("if-none-match")).toBe(
      'W/"v1"',
    );
  });

  it("rejects a cursor it did not produce", async () => {
    expect.hasAssertions();
    const { vcs } = build([]);
    await expectPortError(vcs.events([REPO], "not json"), "invalid");
  });
});

describe("errors", () => {
  const fail = (reply: { status: number; headers?: Record<string, string>; body?: unknown }) =>
    build([
      ...appRoutes(),
      { method: "GET", path: "/repos/acme/app/pulls/1", handler: () => reply },
    ]);

  it.each([
    [404, "not_found"],
    [401, "forbidden"],
    [403, "forbidden"],
    [409, "conflict"],
    [422, "invalid"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    expect.hasAssertions();
    await expectPortError(
      fail({ status, body: { message: "nope" } }).vcs.getPullRequest(REPO, 1),
      code,
    );
  });

  it("maps rate limiting from retry-after and from the reset header", async () => {
    const byRetry = await expectPortError(
      fail({
        status: 403,
        headers: { "retry-after": "30" },
        body: { message: "secondary rate limit" },
      }).vcs.getPullRequest(REPO, 1),
      "rate_limited",
    );

    expect(byRetry.retryAfterMs).toBe(30_000);
    const reset = Math.floor(new Date("2026-01-01T00:02:00Z").getTime() / 1000);
    const byReset = await expectPortError(
      fail({
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        body: { message: "API rate limit exceeded" },
      }).vcs.getPullRequest(REPO, 1),
      "rate_limited",
    );

    expect(byReset.retryAfterMs).toBe(120_000);
    await expectPortError(
      fail({ status: 429, body: {} }).vcs.getPullRequest(REPO, 1),
      "rate_limited",
    );
  });

  it("maps GraphQL errors", async () => {
    expect.hasAssertions();
    const gql = (type: string) =>
      build([
        ...appRoutes(),
        {
          method: "POST",
          path: "/graphql",
          handler: () => ({ errors: [{ type, message: "bad" }] }),
        },
      ]).vcs.reviewThreads(REPO, 1);

    await expectPortError(gql("NOT_FOUND"), "not_found");
    await expectPortError(gql("FORBIDDEN"), "forbidden");
    await expectPortError(gql("RATE_LIMITED"), "rate_limited");
    await expectPortError(gql("OTHER"), "invalid");
  });

  it("wraps fetch exceptions as unavailable", async () => {
    const down = createGithubVcs({
      options: githubOptions.parse({ apiUrl: "https://api.github.test" }),
      secrets: secretMap(officeSecrets),
      team,
      log: silentLogger,
      fetch: (async () => {
        throw new TypeError("connection refused");
      }) as typeof fetch,
      now: () => new Date(),
    });

    const error = await down.getPullRequest(REPO, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).code).toBe("unavailable");
  });
});

describe("links and options", () => {
  it("builds links from webUrl, including for Enterprise hosts", () => {
    const { vcs } = build([], officeSecrets, {}, clock(), {
      apiUrl: "https://ghe.acme.example/api/v3",
      webUrl: "https://ghe.acme.example/",
    });

    expect(vcs.links.pr(REPO, 3)).toBe("https://ghe.acme.example/acme/app/pull/3");
    expect(vcs.links.commit(REPO, "abc")).toBe("https://ghe.acme.example/acme/app/commit/abc");
    expect(vcs.links.thread(REPO, 3, "T1")).toBe(
      "https://ghe.acme.example/acme/app/pull/3#discussion_T1",
    );
  });

  it("derives the GraphQL endpoint: /graphql for GitHub.com, /api/graphql for Enterprise", async () => {
    const empty = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      },
    };

    const dotcom = build([
      ...appRoutes(),
      { method: "POST", path: "/graphql", handler: () => empty },
    ]);

    await expect(dotcom.vcs.reviewThreads(REPO, 1)).resolves.toEqual([]);
    const ghe = build(
      [
        ...appRoutes("ghs", 7, "2026-01-01T01:00:00Z", "/api/v3"),
        { method: "POST", path: "/api/graphql", handler: () => empty },
      ],
      officeSecrets,
      {},
      clock(),
      { apiUrl: "https://api.github.test/api/v3" },
    );

    await expect(ghe.vcs.reviewThreads(REPO, 1)).resolves.toEqual([]);
  });
});
