import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { doctorGithub } from "./doctor.js";
import { testKey } from "./testing/keys.js";

const team = {
  team: { name: "acme" },
  repos: [
    { name: "shop", url: "github.com/acme-example/shop", kind: "primary" },
    { name: "infra", url: "github.com/acme-example/infra", kind: "infra" },
  ],
  people: [],
} as unknown as TeamConfig;

const sam = {
  handle: "sam",
  name: "Sam",
  repos: { shop: "write", infra: "read" },
  identities: { vcs: "acme-sam[bot]" },
};

const WRITE = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  statuses: "read",
};

const READ = { ...WRITE, contents: "read", pull_requests: "read", issues: "read" };

interface Fake {
  app?: { status?: number; slug?: string };
  installation?: { status?: number; account?: string; selection?: string; permissions?: object };
  repos?: string[];
}

function fake(apps: Record<string, Fake>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    // The App id is in the JWT's iss claim; installation tokens carry the id.
    const auth = String((init!.headers as Record<string, string>)["authorization"]);
    const jwt = auth.replace("Bearer ", "");
    const claims = jwt.startsWith("tok-")
      ? { iss: jwt.slice(4) }
      : JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());

    const a = apps[claims.iss] ?? {};
    if (path === "/app") {
      return a.app?.status
        ? json(a.app.status, {})
        : json(200, { slug: a.app?.slug ?? `acme-${claims.iss}` });
    }

    if (/^\/app\/installations\/\d+$/.test(path)) {
      const i = a.installation ?? {};
      return i.status
        ? json(i.status, {})
        : json(200, {
            account: { login: i.account ?? "acme-example" },
            repository_selection: i.selection ?? "selected",
            permissions: i.permissions ?? READ,
          });
    }

    if (path.endsWith("/access_tokens")) {
      return json(201, { token: `tok-${claims.iss}` });
    }

    if (path === "/installation/repositories") {
      return json(200, {
        repositories: (a.repos ?? []).map((full_name) => ({ full_name })),
      });
    }

    return json(404, {});
  }) as typeof fetch;

  return { impl, calls };
}

const secrets = (extra: Record<string, string> = {}) =>
  envSecretSource(
    {
      GH_APP_ID: "11",
      GH_APP_PRIVATE_KEY: testKey.privateKey,
      GH_APP_INSTALLATION_ID: "100",
      GH_APP_SLUG: "acme-sam",
      GH_OFFICE_APP_ID: "22",
      GH_OFFICE_APP_PRIVATE_KEY: testKey.privateKey,
      GH_OFFICE_APP_INSTALLATION_ID: "200",
      ...extra,
    },
    "/nonexistent",
  );

const ctx = (f: typeof fetch, scope: "person" | "office" = "person"): DeriveContext => ({
  team,
  scope,
  options: {},
  ...(scope === "person" ? { person: sam as never } : {}),
  fetch: f,
  now: () => new Date("2026-01-01T00:00:00Z"),
  warn: () => {},
});

const good: Record<string, Fake> = {
  "11": {
    app: { slug: "acme-sam" },
    installation: { permissions: WRITE },
    repos: ["Acme-Example/shop"],
  },
  "22": {
    app: { slug: "acme-office" },
    repos: ["acme-example/shop", "acme-example/infra", "acme-example/docs"],
  },
};

const by = (checks: { name: string; status: string; detail: string }[], name: string) =>
  checks.filter((c) => c.name.includes(name));

describe("doctorGithub", () => {
  it("passes for a correctly installed pair of Apps", async () => {
    const { impl } = fake(good);
    const checks = await doctorGithub(secrets(), ctx(impl));
    expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(checks.length).toBeGreaterThan(8);
  });

  it("fails when the key is rejected, naming the value", async () => {
    const { impl } = fake({ ...good, "11": { app: { status: 401 } } });
    const checks = await doctorGithub(secrets(), ctx(impl));
    expect(by(checks, "GitHub App: authenticates")[0]).toMatchObject({
      status: "fail",
      key: "GH_APP_ID",
    });

    expect(checks[0]!.detail).toContain("GH_APP_ID or GH_APP_PRIVATE_KEY");
  });

  it("fails on a key that is not PEM, without signing a request", async () => {
    const { impl, calls } = fake(good);
    const checks = await doctorGithub(
      secrets({ GH_APP_PRIVATE_KEY: "not a key" }),
      ctx(impl, "person"),
    );

    expect(checks[0]).toMatchObject({ status: "fail", key: "GH_APP_PRIVATE_KEY" });
    expect(calls.filter((c) => c.includes("/installations/100"))).toEqual([]);
  });

  it("fails when the slug or the configured bot login does not match", async () => {
    const { impl } = fake(good);
    const slug = await doctorGithub(secrets({ GH_APP_SLUG: "acme-other" }), ctx(impl));
    expect(by(slug, "slug")[0]!.detail).toBe(
      'GH_APP_SLUG is "acme-other" but the App\'s slug is "acme-sam".',
    );

    const c = ctx(impl);
    c.person = { ...sam, identities: { vcs: "acme-x[bot]" } } as never;
    const identity = await doctorGithub(secrets(), c);
    expect(by(identity, "identity")[0]).toMatchObject({ status: "fail" });
    expect(by(identity, "identity")[0]!.detail).toContain("acme-x[bot]");
  });

  it("fails when the installation id is unknown or on another account", async () => {
    const unknown = fake({ ...good, "11": { ...good["11"]!, installation: { status: 404 } } });
    expect(
      by(await doctorGithub(secrets(), ctx(unknown.impl)), "GitHub App: installation")[0],
    ).toMatchObject({ status: "fail", key: "GH_APP_INSTALLATION_ID" });

    const other = fake({
      ...good,
      "11": { ...good["11"]!, installation: { account: "someone-else", permissions: WRITE } },
    });

    const r = await doctorGithub(secrets(), ctx(other.impl));
    expect(by(r, "GitHub App: installation")[0]!.detail).toContain('belongs to "someone-else"');
  });

  it("fails when the own App misses the repository the person writes", async () => {
    const { impl } = fake({ ...good, "11": { ...good["11"]!, repos: ["acme-example/docs"] } });
    const missing = by(await doctorGithub(secrets(), ctx(impl)), "GitHub App: repositories")[0]!;
    expect(missing).toMatchObject({ status: "fail" });
    expect(missing.detail).toContain("acme-example/shop");
  });

  it("warns when the own App also covers a repository the person only reads or lacks a grant on", async () => {
    const { impl } = fake({
      ...good,
      "11": {
        ...good["11"]!,
        repos: ["acme-example/shop", "acme-example/infra", "acme-example/docs"],
      },
    });

    const checks = await doctorGithub(secrets(), ctx(impl));
    const extra = checks.find((c) => c.name === "GitHub App: extra repositories")!;
    expect(extra).toMatchObject({ status: "warn" });
    expect(extra.detail).toBe(
      "The App can write to acme-example/infra, acme-example/docs, which this person may only read (or has no grant on).",
    );

    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  it("does not require read-granted repositories on the own App, only on the office App", async () => {
    const { impl } = fake(good);
    const checks = await doctorGithub(secrets(), ctx(impl));
    expect(by(checks, "GitHub App: repositories")[0]!.detail).toBe(
      "The installation covers acme-example/shop.",
    );

    const office = fake({ ...good, "22": { ...good["22"]!, repos: ["acme-example/shop"] } });
    const r = await doctorGithub(secrets(), ctx(office.impl));
    expect(by(r, "Office GitHub App: repositories")[0]).toMatchObject({ status: "fail" });
    expect(by(r, "Office GitHub App: repositories")[0]!.detail).toContain("acme-example/infra");
  });

  it("does not count a write grant a readonly role profile ignores", async () => {
    const c = ctx(
      fake({ ...good, "11": { ...good["11"]!, installation: { permissions: READ } } }).impl,
    );

    c.profile = "readonly";
    const checks = await doctorGithub(secrets(), c);
    expect(checks.filter((x) => x.status === "fail")).toEqual([]);
    expect(by(checks, "GitHub App: extra repositories")).toEqual([]);
  });

  it("warns when the App is installed on all repositories", async () => {
    const { impl } = fake({
      ...good,
      "11": { ...good["11"]!, installation: { selection: "all", permissions: WRITE } },
    });

    expect(
      by(await doctorGithub(secrets(), ctx(impl)), "GitHub App: repositories")[0],
    ).toMatchObject({ status: "warn" });
  });

  it("fails when the role changes CI and the App lacks the Workflows permission", async () => {
    const devopsCtx = (f: typeof fetch) => ({
      ...ctx(f),
      roleCapabilities: ["vcs.pullRequests", "vcs.workflows"] as never,
    });

    const without = await doctorGithub(secrets(), devopsCtx(fake(good).impl));
    expect(by(without, "GitHub App: permissions")[0]).toMatchObject({ status: "fail" });
    expect(by(without, "GitHub App: permissions")[0]!.detail).toContain("workflows:write");

    const withIt = fake({
      ...good,
      "11": { ...good["11"]!, installation: { permissions: { ...WRITE, workflows: "write" } } },
    });

    const ok = await doctorGithub(secrets(), devopsCtx(withIt.impl));
    expect(ok.filter((c) => c.status !== "ok")).toEqual([]);

    // A developer is not asked for it.
    const dev = await doctorGithub(secrets(), ctx(fake(good).impl));
    expect(by(dev, "GitHub App: permissions")[0]!.detail).not.toContain("workflows");
  });

  it("warns about permissions the role does not need, including Workflows for a developer", async () => {
    const extra = fake({
      ...good,
      "11": {
        ...good["11"]!,
        installation: { permissions: { ...WRITE, repository_hooks: "write", workflows: "write" } },
      },
    });

    const r = await doctorGithub(secrets(), ctx(extra.impl));
    const found = by(r, "surplus permissions")[0]!;
    expect(found).toMatchObject({ status: "warn" });
    expect(found.detail).toContain("repository_hooks:write");
    expect(found.detail).toContain("workflows:write");
  });

  it("fails when a write grant lacks write permissions, and warns on unused write access", async () => {
    const lacking = fake({
      ...good,
      "11": { ...good["11"]!, installation: { permissions: READ } },
    });

    const r = await doctorGithub(secrets(), ctx(lacking.impl));
    expect(by(r, "GitHub App: permissions")[0]!.detail).toContain(
      "contents:write, pull_requests:write, issues:write",
    );

    const readerCtx = ctx(fake(good).impl);
    readerCtx.person = { ...sam, repos: { shop: "read" } } as never;
    const reader = await doctorGithub(secrets(), readerCtx);
    expect(by(reader, "unused write access")[0]).toMatchObject({ status: "warn" });
  });

  it("fails when the office App has any write permission, and checks every team repository", async () => {
    const { impl } = fake({
      ...good,
      "22": { ...good["22"]!, installation: { permissions: { ...READ, contents: "write" } } },
    });

    const checks = await doctorGithub(secrets(), ctx(impl, "office"));
    expect(by(checks, "read-only")[0]).toMatchObject({ status: "fail" });
    expect(by(checks, "read-only")[0]!.detail).toContain("contents:write");
    // The person's own App is not looked at for the office.
    expect(checks.every((c) => !c.name.startsWith("GitHub App"))).toBe(true);
  });

  it("fails when the office App does not cover a team repository", async () => {
    const { impl } = fake({ ...good, "22": { ...good["22"]!, repos: ["acme-example/shop"] } });
    const checks = await doctorGithub(secrets(), ctx(impl, "office"));
    expect(by(checks, "Office GitHub App: repositories")[0]!.detail).toContain(
      "acme-example/infra",
    );
  });

  it("reports an unreachable GitHub as a failure", async () => {
    const checks = await doctorGithub(
      secrets(),
      ctx((async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch),
    );

    expect(checks.filter((c) => c.status === "fail")).toHaveLength(2);
    expect(checks[0]!.detail).toContain("ECONNREFUSED");
  });

  it("skips an App with no id or key", async () => {
    const { impl, calls } = fake(good);
    const none = envSecretSource({}, "/nonexistent");
    expect(await doctorGithub(none, ctx(impl))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("skips GitHub for a person without repository grants", async () => {
    const { impl, calls } = fake(good);
    const checks = await doctorGithub(secrets(), {
      ...ctx(impl),
      person: { ...sam, repos: {}, identities: undefined } as never,
    });

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("no GitHub credentials"),
    });

    expect(calls).toEqual([]);
  });
});
