import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { deriveGithub, githubSetupGuide } from "../setup.js";
import { testKey } from "../testing/keys.js";

const team = {
  team: { name: "acme" },
  repos: [
    { name: "shop", url: "github.com/acme-example/shop", kind: "primary" },
    { name: "infra", url: "github.com/acme-example/infra", kind: "infra" },
  ],
  people: [],
} as unknown as TeamConfig;

const sam = { handle: "sam", name: "Sam", repos: { shop: "write", infra: "read" } };

describe("githubSetupGuide", () => {
  it("asks a writer's App for write permissions on the granted repositories", () => {
    const steps = githubSetupGuide({
      team,
      scope: "person",
      options: {},
      person: sam as never,
    });

    expect(steps.map((s) => s.title)).toEqual([
      "Create Sam's GitHub App",
      "Install it on exactly the repositories this person can write",
      "Generate a private key and copy the keys",
      "Add the office App's keys",
    ]);

    expect(JSON.parse(steps[0]!.manifest!).default_permissions).toMatchObject({
      contents: "write",
      pull_requests: "write",
      checks: "read",
    });

    expect(steps[1]!.body).toContain("`github.com/acme-example/shop`");
    expect(steps[1]!.body).not.toContain("infra");
    expect(steps[1]!.body).toContain("office App");
    expect(steps[2]!.body).toContain("GH_APP_SLUG");
  });

  it("asks for Workflows only when the role changes CI, and names the risk", () => {
    const guide = (roleCapabilities: string[]) =>
      githubSetupGuide({
        team,
        scope: "person",
        options: {},
        person: sam as never,
        roleCapabilities: roleCapabilities as never,
      })[0]!;

    const devops = guide(["vcs.pullRequests", "vcs.workflows"]);
    expect(JSON.parse(devops.manifest!).default_permissions).toMatchObject({ workflows: "write" });
    expect(devops.body).toContain("Actions secrets");

    const developer = guide(["vcs.pullRequests", "vcs.reviewThreads"]);
    expect(JSON.parse(developer.manifest!).default_permissions).not.toHaveProperty("workflows");
    expect(developer.body).not.toContain("Workflows");
  });

  it("keeps a reader's App read-only", () => {
    const [create] = githubSetupGuide({
      team,
      scope: "person",
      options: {},
      person: { ...sam, repos: { shop: "read" } } as never,
    });

    expect(Object.values(JSON.parse(create!.manifest!).default_permissions)).toEqual(
      Array(6).fill("read"),
    );
  });

  it("sends a person without grants to no App at all", () => {
    const steps = githubSetupGuide({
      team,
      scope: "person",
      options: {},
      person: { ...sam, repos: {} } as never,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]!.title).toBe("Sam needs no GitHub credentials");
    expect(steps[0]!.manifest).toBeUndefined();
  });

  it("covers every repository for the office", () => {
    const steps = githubSetupGuide({ team, scope: "office", options: {} });
    expect(steps[1]!.body).toContain("acme-example/shop");
    expect(steps[1]!.body).toContain("acme-example/infra");
    expect(steps[2]!.body).toContain("GH_OFFICE_APP_ID");
  });
});

describe("deriveGithub", () => {
  const calls: string[] = [];
  const warnings: string[] = [];
  const fetchStub = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const body: Record<string, unknown> = {
      "/app": { slug: "acme-sam" },
      "/app/installations": [
        { id: 7, account: { login: "someone-else" } },
        { id: 99, account: { login: "Acme-Example" } },
      ],
      "/users/acme-sam[bot]": { id: 1234 },
    };

    const found = body[path] ?? body[decodeURIComponent(path)];
    return found === undefined
      ? new Response("{}", { status: 404 })
      : new Response(JSON.stringify(found), { status: 200 });
  }) as typeof fetch;

  const ctx = (): DeriveContext => ({
    team,
    scope: "person",
    options: {},
    fetch: fetchStub,
    now: () => new Date("2026-01-01T00:00:00Z"),
    warn: (m) => warnings.push(m),
  });

  it("looks up slug, installation id and bot email from the App id and key", async () => {
    const secrets = envSecretSource(
      { GH_APP_ID: "42", GH_APP_PRIVATE_KEY: testKey.privateKey },
      "/nonexistent",
    );

    expect(await deriveGithub(secrets, ctx())).toEqual({
      GH_APP_SLUG: "acme-sam",
      GH_APP_INSTALLATION_ID: "99",
      GH_APP_BOT_EMAIL: "1234+acme-sam[bot]@users.noreply.github.com",
    });
  });

  it("skips values that are already provided and Apps without a key", async () => {
    calls.length = 0;
    const secrets = envSecretSource(
      {
        GH_APP_ID: "42",
        GH_APP_PRIVATE_KEY: testKey.privateKey,
        GH_APP_SLUG: "acme-sam",
        GH_APP_INSTALLATION_ID: "5",
        GH_OFFICE_APP_ID: "43",
      },
      "/nonexistent",
    );

    const out = await deriveGithub(secrets, ctx());
    expect(out).toEqual({ GH_APP_BOT_EMAIL: "1234+acme-sam[bot]@users.noreply.github.com" });
    expect(calls).toEqual(["/users/acme-sam%5Bbot%5D"]);
    expect(warnings.at(-1)).toContain("GH_OFFICE_APP_ID is set but there is no private key");
  });

  const derive = (env: Record<string, string>, over: Partial<DeriveContext> = {}) => {
    const warned: string[] = [];
    const run = deriveGithub(envSecretSource(env, "/nonexistent"), {
      ...ctx(),
      warn: (m) => warned.push(m),
      ...over,
    });

    return run.then((out) => ({ out, warned }));
  };

  const app = { GH_APP_ID: "42", GH_APP_PRIVATE_KEY: testKey.privateKey };

  it("reads the private key from the file named by the _FILE key", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "outstaff-gh-")), "key.pem");
    writeFileSync(file, testKey.privateKey);
    const { out, warned } = await derive({ GH_APP_ID: "42", GH_APP_PRIVATE_KEY_FILE: file });
    expect(out).toMatchObject({ GH_APP_SLUG: "acme-sam", GH_APP_INSTALLATION_ID: "99" });
    expect(warned).toEqual([]);
  });

  it("warns and skips an App whose key file cannot be read", async () => {
    const { out, warned } = await derive({
      GH_APP_ID: "42",
      GH_APP_PRIVATE_KEY_FILE: "/nonexistent/key.pem",
    });

    expect(out).toEqual({});
    expect(warned).toEqual(["GH_APP_PRIVATE_KEY_FILE points at a file that cannot be read."]);
  });

  it("warns, and still derives the rest, when the App is installed on none of the team's owners", async () => {
    const noMatch = (async (url: string | URL) => {
      const path = decodeURIComponent(new URL(String(url)).pathname);
      return new Response(
        JSON.stringify(
          path === "/app"
            ? { slug: "acme-sam" }
            : path === "/app/installations"
              ? [{ id: 1, account: null }]
              : { id: 1234 },
        ),
      );
    }) as typeof fetch;

    const { out, warned } = await derive(app, { fetch: noMatch });
    expect(out).not.toHaveProperty("GH_APP_INSTALLATION_ID");
    expect(out).toHaveProperty("GH_APP_BOT_EMAIL");
    expect(warned).toEqual([
      expect.stringContaining("The App acme-sam is not installed on acme-example"),
    ]);
  });

  it("leaves a given bot email alone", async () => {
    const { out } = await derive({ ...app, GH_APP_BOT_EMAIL: "x@y.z" });
    expect(out).not.toHaveProperty("GH_APP_BOT_EMAIL");
  });

  it("warns with the failing App's prefix when GitHub refuses, and carries on with the next", async () => {
    const refuse = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const { out, warned } = await derive(
      { ...app, GH_OFFICE_APP_ID: "43", GH_OFFICE_APP_PRIVATE_KEY: testKey.privateKey },
      { fetch: refuse },
    );

    expect(out).toEqual({});
    expect(warned).toEqual([
      "GitHub GH_APP_: GET /app returned 401",
      "GitHub GH_OFFICE_APP_: GET /app returned 401",
    ]);
  });

  it("derives only the office App for the office scope, with default options", async () => {
    const { out } = await derive(
      { ...app, GH_OFFICE_APP_ID: "43", GH_OFFICE_APP_PRIVATE_KEY: testKey.privateKey },
      { scope: "office", options: undefined as never },
    );

    expect(Object.keys(out).sort()).toEqual([
      "GH_OFFICE_APP_BOT_EMAIL",
      "GH_OFFICE_APP_INSTALLATION_ID",
      "GH_OFFICE_APP_SLUG",
    ]);
  });
});
