import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { deriveGithub, githubSetupGuide } from "./setup.js";
import { testKey } from "./testing/keys.js";

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
      "Install it on exactly the repositories this person is granted",
      "Generate a private key and copy the keys",
      "Add the office App's keys",
    ]);

    expect(JSON.parse(steps[0]!.manifest!).default_permissions).toMatchObject({
      contents: "write",
      pull_requests: "write",
      checks: "read",
    });

    expect(steps[1]!.body).toContain("`github.com/acme-example/shop` (write)");
    expect(steps[1]!.body).toContain("`github.com/acme-example/infra` (read)");
    expect(steps[2]!.body).toContain("GH_APP_SLUG");
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
});
