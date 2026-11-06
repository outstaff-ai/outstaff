import { describe, expect, it } from "vitest";
import type { TeamConfig } from "@outstaff/core";
import {
  build,
  clock,
  installationRoute,
  officeSecrets,
  ORIGIN,
  ownSecrets,
  REPO,
  type Route,
} from "@outstaff/testing.github";

/** The team repository is on acme, a shared library on acme-libs. */
const team = {
  repos: [
    { name: "app", url: "github.com/acme/app", kind: "primary" },
    { name: "kit", url: "github.com/acme-libs/kit", kind: "library" },
  ],
  people: [{ handle: "sam", repos: { app: "write", kit: "write" } }],
} as unknown as TeamConfig;

const KIT = { owner: "acme-libs", name: "kit" };

/** Both Apps are pinned to their acme installation and pass the same ids to every request. */
const pinned = {
  ...officeSecrets,
  ...ownSecrets,
  GH_OFFICE_APP_INSTALLATION_ID: "7",
  GH_APP_INSTALLATION_ID: "8",
  GH_APP_SLUG: "acme-sam",
  OUTSTAFF_PERSON: "sam",
};

const appId = (r: { headers: Headers }) =>
  Number(
    JSON.parse(Buffer.from(r.headers.get("authorization")!.split(".")[1]!, "base64url").toString())
      .iss,
  );

const tokenRoute = (id: number): Route => ({
  method: "POST",
  path: `/app/installations/${id}/access_tokens`,
  handler: () => ({
    status: 201,
    body: { token: `ghs_${id}`, expires_at: "2026-01-01T01:00:00Z" },
  }),
});

/** The office App (iss 100) is installation 7 on acme and 17 on acme-libs; the own App (iss 200) 8 and 18. */
const routes = (libs = true): Route[] => [
  installationRoute(7),
  installationRoute(8),
  {
    method: "GET",
    path: "/app/installations",
    handler: (r) => {
      const base = appId(r) === 100 ? 7 : 8;
      return [
        { id: base, account: { login: "acme" } },
        ...(libs ? [{ id: base + 10, account: { login: "acme-libs" } }] : []),
      ];
    },
  },
  ...[7, 8, 17, 18].map(tokenRoute),
  { method: "GET", path: "/users/:login", handler: () => ({ id: 4242 }) },
];

const make = (libs = true) => build(routes(libs), pinned, {}, clock(), { apiUrl: ORIGIN }, team);

describe("repositories on more than one account", () => {
  it("reads through the office App's installation on each account, the pinned one for its own", async () => {
    const { vcs, stub } = make();
    await expect(vcs.credentials("sam", REPO, "read")).resolves.toMatchObject({ token: "ghs_7" });
    await expect(vcs.credentials("sam", KIT, "read")).resolves.toMatchObject({ token: "ghs_17" });
    expect(stub.called("GET", "/app/installations/7")).toHaveLength(1);
  });

  it("writes through the own App's installation on each account, the pinned one for its own", async () => {
    const { vcs, stub } = make();
    await expect(vcs.credentials("sam", REPO, "write")).resolves.toMatchObject({ token: "ghs_8" });
    await expect(vcs.credentials("sam", KIT, "write")).resolves.toMatchObject({ token: "ghs_18" });
    expect(stub.called("POST", "/app/installations/8/access_tokens")[0]!.json.repositories).toEqual(
      ["app"],
    );

    expect(
      stub.called("POST", "/app/installations/18/access_tokens")[0]!.json.repositories,
    ).toEqual(["kit"]);
  });

  it("names the account an App is not installed on", async () => {
    const { vcs } = make(false);
    await expect(vcs.credentials("sam", KIT, "read")).rejects.toThrow(
      'not installed on "acme-libs"',
    );

    await expect(vcs.credentials("sam", KIT, "write")).rejects.toThrow(
      'not installed on "acme-libs"',
    );
  });
});
