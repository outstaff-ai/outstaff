import { describe, expect, it } from "vitest";
import { AppAuth, REFRESH_MARGIN_MS } from "#/auth.js";
import { GithubHttp } from "#/http.js";
import {
  clock,
  createStubFetch,
  expectPortError,
  installationRoute,
  ORIGIN,
  REPO,
  type Route,
} from "@outstaff/testing.github";
import { testKey } from "@outstaff/testing.core";
import type { AppCredentials } from "#/types.js";

function setup(routes: Route[], creds: Partial<AppCredentials> = {}) {
  const c = clock();
  const stub = createStubFetch(routes, ORIGIN);
  const http = new GithubHttp({
    fetch: stub.fetch,
    apiUrl: ORIGIN,
    graphqlUrl: `${ORIGIN}/graphql`,
    now: c.now,
  });

  const auth = new AppAuth(http, c.now, { appId: "1", privateKey: testKey.privateKey, ...creds });
  return { auth, stub, clock: c };
}

const token = (expires = "2026-01-01T01:00:00Z"): Route => ({
  method: "POST",
  path: "/app/installations/7/access_tokens",
  handler: () => ({ status: 201, body: { token: "ghs_x", expires_at: expires } }),
});

describe("AppAuth.slug", () => {
  it("answers from the credentials without a request", async () => {
    const { auth, stub } = setup([], { slug: "acme-bot" });
    await expect(auth.slug()).resolves.toBe("acme-bot");
    expect(stub.calls).toHaveLength(0);
  });

  it("looks the slug up once, and again after a failure", async () => {
    let fail = true;
    const { auth, stub } = setup([
      {
        method: "GET",
        path: "/app",
        handler: () => (fail ? { status: 500, body: { message: "down" } } : { slug: "acme-bot" }),
      },
    ]);

    await expectPortError(auth.slug(), "unavailable");
    await Promise.resolve();
    fail = false;
    await expect(auth.slug()).resolves.toBe("acme-bot");
    await expect(auth.slug()).resolves.toBe("acme-bot");
    expect(stub.called("GET", "/app")).toHaveLength(2);
  });
});

describe("AppAuth.installationId", () => {
  const list = (installs: unknown[]): Route => ({
    method: "GET",
    path: "/app/installations",
    handler: () => installs,
  });

  it("uses the pinned installation for its own account after one lookup, without listing", async () => {
    const { auth, stub } = setup([installationRoute(99, undefined, "Acme")], {
      installationId: "99",
    });

    await expect(auth.installationId("acme")).resolves.toBe("99");
    await expect(auth.installationId("ACME")).resolves.toBe("99");
    expect(stub.called("GET", "/app/installations/99")).toHaveLength(1);
    expect(stub.called("GET", "/app/installations")).toHaveLength(0);
  });

  it("looks up another account's installation instead of using the pinned one", async () => {
    const { auth, stub } = setup(
      [
        installationRoute(99),
        list([
          { id: 99, account: { login: "acme" } },
          { id: 5, account: { login: "acme-libs" } },
        ]),
      ],
      { installationId: "99" },
    );

    await expect(auth.installationId("acme-libs")).resolves.toBe("5");
    await expect(auth.installationId("acme-libs")).resolves.toBe("5");
    await expect(auth.installationId("acme")).resolves.toBe("99");
    expect(stub.called("GET", "/app/installations")).toHaveLength(1);
    expect(stub.called("GET", "/app/installations/99")).toHaveLength(1);
  });

  it("is forbidden for another account the App is not installed on, even with an id pinned", async () => {
    const { auth } = setup(
      [installationRoute(99), list([{ id: 99, account: { login: "acme" } }])],
      {
        installationId: "99",
      },
    );

    const e = await expectPortError(auth.installationId("acme-libs"), "forbidden");
    expect(e.message).toContain('"acme-libs"');
  });

  it("treats a pinned installation without an account as no account's", async () => {
    const { auth } = setup(
      [
        { method: "GET", path: "/app/installations/99", handler: () => ({ account: null }) },
        list([{ id: 3, account: { login: "acme" } }]),
      ],
      { installationId: "99" },
    );

    await expect(auth.installationId("acme")).resolves.toBe("3");
  });

  it("fails while the pinned installation cannot be read, and reads it again on the next call", async () => {
    let fail = true;
    const { auth, stub } = setup(
      [
        {
          method: "GET",
          path: "/app/installations/99",
          handler: () =>
            fail ? { status: 500, body: { message: "down" } } : { account: { login: "acme" } },
        },
      ],
      { installationId: "99" },
    );

    await expectPortError(auth.installationId("acme"), "unavailable");
    await Promise.resolve();
    fail = false;
    await expect(auth.installationId("acme")).resolves.toBe("99");
    expect(stub.called("GET", "/app/installations/99")).toHaveLength(2);
  });

  it("finds the installation by owner, ignoring case, and remembers it", async () => {
    const { auth, stub } = setup([
      {
        method: "GET",
        path: "/app/installations",
        handler: () => [
          { id: 1, account: null },
          { id: 2, account: { login: "Acme" } },
        ],
      },
    ]);

    await expect(auth.installationId("acme")).resolves.toBe("2");
    await expect(auth.installationId("ACME")).resolves.toBe("2");
    expect(stub.called("GET", "/app/installations")).toHaveLength(1);
  });

  it("is forbidden when the App is not installed on the owner", async () => {
    const { auth } = setup([{ method: "GET", path: "/app/installations", handler: () => [] }]);
    const e = await expectPortError(auth.installationId("acme"), "forbidden");
    expect(e.message).toContain('"acme"');
  });
});

describe("AppAuth.token", () => {
  const installation = (permissions: unknown): Route => ({
    method: "GET",
    path: "/app/installations/7",
    handler: () => ({
      account: { login: "acme" },
      ...(permissions === undefined ? {} : { permissions }),
    }),
  });

  it("reuses a token until the refresh margin, then requests a new one", async () => {
    const {
      auth,
      stub,
      clock: c,
    } = setup([token(), installationRoute(7)], { installationId: "7" });

    await auth.token(REPO);
    await auth.token(REPO);
    expect(stub.called("POST", "/app/installations/7/access_tokens")).toHaveLength(1);

    c.advance(60 * 60_000 - REFRESH_MARGIN_MS + 1);
    await auth.token(REPO);
    expect(stub.called("POST", "/app/installations/7/access_tokens")).toHaveLength(2);
  });

  it("sends the repositories and permissions it was scoped to", async () => {
    const { auth, stub } = setup([token(), installationRoute(7)], { installationId: "7" });
    await auth.token(REPO, { repositories: ["app"], permissions: { contents: "read" } });
    expect(stub.called("POST", "/app/installations/7/access_tokens")[0]!.json).toEqual({
      repositories: ["app"],
      permissions: { contents: "read" },
    });
  });

  it("adds an optional permission only at the level the installation holds", async () => {
    const { auth, stub } = setup([token(), installation({ actions: "read", workflows: "read" })], {
      installationId: "7",
    });

    await auth.token(REPO, {
      permissions: { contents: "read" },
      optionalPermissions: { actions: "read", workflows: "write", checks: "read" },
    });

    expect(stub.called("POST", "/app/installations/7/access_tokens")[0]!.json.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
  });

  it("reads the granted permissions once within the cache window and again after it", async () => {
    const {
      auth,
      stub,
      clock: c,
    } = setup([token("2026-01-02T00:00:00Z"), installation({})], {
      installationId: "7",
    });

    const scope = { optionalPermissions: { actions: "read" } } as const;
    await auth.token(REPO, scope);
    await auth.token({ ...REPO, name: "other" }, scope);
    expect(stub.called("GET", "/app/installations/7")).toHaveLength(1);

    c.advance(11 * 60_000);
    await auth.token(REPO, scope);
    expect(stub.called("GET", "/app/installations/7")).toHaveLength(2);
  });

  const listed: Route = {
    method: "GET",
    path: "/app/installations",
    handler: () => [{ id: 7, account: { login: "acme" } }],
  };

  it.each([
    ["pinned", { installationId: "7" }],
    ["looked up", {}],
  ] as const)("treats an answer without permissions as none (%s)", async (_, creds) => {
    const { auth, stub } = setup([token(), installation(undefined), listed], creds);
    await auth.token(REPO, { optionalPermissions: { actions: "read" } });
    expect(stub.called("POST", "/app/installations/7/access_tokens")[0]!.json).toEqual({});
    expect(stub.called("GET", "/app/installations/7")).toHaveLength(1);
  });

  it("asks without the optional permissions when the installation cannot be read", async () => {
    const { auth, stub } = setup([
      token(),
      listed,
      {
        method: "GET",
        path: "/app/installations/7",
        handler: () => ({ status: 500, body: { message: "down" } }),
      },
    ]);

    await auth.token(REPO, {
      permissions: { contents: "read" },
      optionalPermissions: { actions: "read" },
    });

    expect(stub.called("POST", "/app/installations/7/access_tokens")[0]!.json.permissions).toEqual({
      contents: "read",
    });
  });

  it("mints a second account's token from its own installation while an id is pinned", async () => {
    const { auth } = setup(
      [
        token(),
        installationRoute(7),
        {
          method: "GET",
          path: "/app/installations",
          handler: () => [
            { id: 7, account: { login: "acme" } },
            { id: 9, account: { login: "acme-libs" } },
          ],
        },
        {
          method: "POST",
          path: "/app/installations/9/access_tokens",
          handler: () => ({
            status: 201,
            body: { token: "ghs_libs", expires_at: "2026-01-01T01:00:00Z" },
          }),
        },
      ],
      { installationId: "7" },
    );

    await expect(auth.token(REPO)).resolves.toMatchObject({ token: "ghs_x" });
    await expect(auth.token({ owner: "acme-libs", name: "kit" })).resolves.toMatchObject({
      token: "ghs_libs",
    });
  });
});
