import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { testKey } from "@outstaff/testing.core";

export const team = {
  team: { name: "acme" },
  repos: [
    { name: "shop", url: "github.com/acme-example/shop", kind: "primary" },
    { name: "infra", url: "github.com/acme-example/infra", kind: "infra" },
  ],
  people: [],
} as unknown as TeamConfig;

export const sam = {
  handle: "sam",
  name: "Sam",
  repos: { shop: "write", infra: "read" },
  identities: { vcs: "acme-sam[bot]" },
};

export const WRITE = {
  actions: "read",
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  statuses: "read",
};

const { actions: _actions, ...READ_BASE } = WRITE;
export const READ = { ...READ_BASE, contents: "read", pull_requests: "read", issues: "read" };

/** The office App also reads the logs of checks that fail after a merge. */
export const OFFICE = { ...READ, actions: "read" };

interface Fake {
  app?: { status?: number; slug?: string };
  installation?: { status?: number; account?: string; selection?: string; permissions?: object };
  repos?: string[];

  /** Repositories (`owner/name`) that have a `.github/workflows/` directory. */
  workflows?: string[];
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

/** The App id is in the JWT's iss claim; installation tokens carry the id. */
function appIdOf(init?: RequestInit): string {
  const auth = String((init!.headers as Record<string, string>)["authorization"]);
  const jwt = auth.replace("Bearer ", "");
  return jwt.startsWith("tok-")
    ? jwt.slice(4)
    : JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).iss;
}

function appReply(a: Fake, iss: string): Response {
  return a.app?.status ? json(a.app.status, {}) : json(200, { slug: a.app?.slug ?? `acme-${iss}` });
}

function installationReply(a: Fake): Response {
  const i = a.installation ?? {};
  return i.status
    ? json(i.status, {})
    : json(200, {
        account: { login: i.account ?? "acme-example" },
        repository_selection: i.selection ?? "selected",
        permissions: i.permissions ?? OFFICE,
      });
}

const WORKFLOWS = /^\/repos\/(.+)\/contents\/\.github\/workflows$/;

function workflowsReply(a: Fake, path: string): Response {
  const repo = WORKFLOWS.exec(path)![1]!;
  return (a.workflows ?? []).includes(repo) ? json(200, []) : json(404, {});
}

const ROUTES: [(path: string) => boolean, (a: Fake, iss: string, path: string) => Response][] = [
  [(path) => path === "/app", appReply],
  [(path) => /^\/app\/installations\/\d+$/.test(path), installationReply],
  [(path) => path.endsWith("/access_tokens"), (_a, iss) => json(201, { token: `tok-${iss}` })],
  [
    (path) => path === "/installation/repositories",
    (a) => json(200, { repositories: (a.repos ?? []).map((full_name) => ({ full_name })) }),
  ],
  [(path) => WORKFLOWS.test(path), (a, _iss, path) => workflowsReply(a, path)],
];

/** A fake GitHub for the doctor tests: the App, installation and contents endpoints, answered per App id. */
export function fake(apps: Record<string, Fake>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const iss = appIdOf(init);
    const reply = ROUTES.find(([matches]) => matches(path))?.[1];
    return reply ? reply(apps[iss] ?? {}, iss, path) : json(404, {});
  }) as typeof fetch;

  return { impl, calls };
}

export const secrets = (extra: Record<string, string> = {}) =>
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

export const ctx = (f: typeof fetch, scope: "person" | "office" = "person"): DeriveContext => ({
  team,
  scope,
  options: {},
  ...(scope === "person" ? { person: sam as never } : {}),
  fetch: f,
  now: () => new Date("2026-01-01T00:00:00Z"),
  warn: () => {},
});

export const good: Record<string, Fake> = {
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

export const by = (checks: { name: string; status: string; detail: string }[], name: string) =>
  checks.filter((c) => c.name.includes(name));
