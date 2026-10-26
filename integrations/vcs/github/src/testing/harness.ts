import type { AdapterContext, SecretSource, TeamConfig } from "@outstaff/core";
import { silentLogger, PortError, type PortErrorCode } from "@outstaff/core";
import { expect } from "vitest";
import { githubOptions } from "../options.js";
import type { GithubDeps } from "../types.js";
import { createGithubVcs } from "../vcs.js";
import { createStubFetch } from "./http-stub.js";
import type { Clock, Route } from "./types.js";
import { testKey } from "./keys.js";

export const REPO = { owner: "acme", name: "app" };
export const ORIGIN = "https://api.github.test";

export const secretMap = (values: Record<string, string>): SecretSource => ({
  get: (k) => values[k],
  require(k) {
    const v = values[k];
    if (v === undefined) {
      throw new Error(`missing ${k}`);
    }

    return v;
  },
});

/** sam writes, noor reads through a kind grant, kit reads through "*", lee has no grant; "app" is the primary repo. */
export const team = {
  repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
  people: [
    { handle: "sam", identities: { vcs: "sam[bot]" }, repos: { app: "write" } },
    { handle: "noor", repos: { "kind:primary": "read" } },
    { handle: "kit", repos: { "*": "read" } },
    { handle: "lee", repos: {} },
  ],
} as unknown as TeamConfig;

export function clock(start = "2026-01-01T00:00:00Z"): Clock {
  const c: Clock = {
    date: new Date(start),
    now: () => new Date(c.date),
    advance: (ms) => void (c.date = new Date(c.date.getTime() + ms)),
  };

  return c;
}

export const officeSecrets = {
  GH_OFFICE_APP_ID: "100",
  GH_OFFICE_APP_PRIVATE_KEY: testKey.privateKey,
};

export const ownSecrets = { GH_APP_ID: "200", GH_APP_PRIVATE_KEY: testKey.privateKey };

/** Routes every adapter call needs: installation lookup and an installation token. */
export function appRoutes(
  prefix = "ghs",
  installation = 7,
  expiresAt = "2026-01-01T01:00:00Z",
  root = "",
): Route[] {
  let n = 0;
  return [
    {
      method: "GET",
      path: `${root}/app/installations`,
      handler: () => [{ id: installation, account: { login: "acme" } }],
    },
    {
      method: "POST",
      path: `${root}/app/installations/${installation}/access_tokens`,
      handler: () => ({ status: 201, body: { token: `${prefix}_${++n}`, expires_at: expiresAt } }),
    },
  ];
}

export function build(
  routes: Route[],
  secrets: Record<string, string> = officeSecrets,
  deps: GithubDeps = {},
  c: Clock = clock(),
  options: Record<string, unknown> = { apiUrl: ORIGIN },
  teamConfig: TeamConfig = team,
) {
  const stub = createStubFetch(routes, ORIGIN);
  const ctx: AdapterContext<ReturnType<typeof githubOptions.parse>> = {
    options: githubOptions.parse(options),
    secrets: secretMap(secrets),
    team: teamConfig,
    log: silentLogger,
    fetch: stub.fetch,
    now: c.now,
  };

  return { vcs: createGithubVcs(ctx, { sleep: async () => {}, ...deps }), stub, clock: c };
}

export async function expectPortError(
  promise: Promise<unknown>,
  code: PortErrorCode,
): Promise<PortError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(PortError);
  expect((error as PortError).code).toBe(code);
  return error as PortError;
}
