import type { TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { doctorGithub } from "#/doctor.js";
import { ctx, fake, good, json, OFFICE, sam, secrets, WRITE } from "./doctor-fake.js";

/** The team repositories are on acme-example, a shared library on acme-libs. */
const team = {
  team: { name: "acme" },
  repos: [
    { name: "shop", url: "github.com/acme-example/shop", kind: "primary" },
    { name: "infra", url: "github.com/acme-example/infra", kind: "infra" },
    { name: "kit", url: "github.com/acme-libs/kit", kind: "library" },
  ],
  people: [],
} as unknown as TeamConfig;

/** sam writes shop and kit and reads infra. */
const person = { ...sam, repos: { shop: "write", infra: "read", kit: "write" } };

/** Both Apps are also installed on acme-libs, covering kit. */
const both = {
  "11": {
    ...good["11"]!,
    others: [{ id: 101, account: "acme-libs", permissions: WRITE, repos: ["acme-libs/kit"] }],
  },
  "22": {
    ...good["22"]!,
    repos: ["acme-example/shop", "acme-example/infra"],
    others: [{ id: 201, account: "acme-libs", permissions: OFFICE, repos: ["acme-libs/kit"] }],
  },
};

const scopes = [
  ["person", "GitHub App"],
  ["office", "Office GitHub App"],
] as const;

function context(f: typeof fetch, scope: "person" | "office") {
  const c = { ...ctx(f, scope), team };
  return scope === "person" ? { ...c, person: person as never } : c;
}

/** Checks by their exact name: "GitHub App" is also part of "Office GitHub App". */
const by = (
  checks: { name: string; status: string; detail: string; fix?: string }[],
  name: string,
) => checks.filter((c) => c.name === name);

const failures = (checks: { status: string }[]) => checks.filter((c) => c.status !== "ok");

describe("doctorGithub: repositories on more than one account", () => {
  it.each(scopes)("passes when the %s App is installed on both accounts", async (scope, label) => {
    const { impl, calls } = fake(both);
    const checks = await doctorGithub(secrets(), context(impl, scope));
    expect(failures(checks)).toEqual([]);
    expect(by(checks, `${label} on acme-libs: installation`)[0]!.detail).toContain(
      "installed on acme-libs",
    );

    expect(by(checks, `${label} on acme-libs: repositories`)[0]!.detail).toBe(
      "The installation covers acme-libs/kit.",
    );

    expect(by(checks, `${label} on acme-example: repositories`)).toHaveLength(1);
    expect(by(checks, `${label}: installation`)[0]!.detail).toContain("on acme-example");
    expect(calls.filter((c) => c === "GET /app/installations").length).toBeGreaterThan(0);
  });

  it.each(scopes)(
    "fails naming the account the %s App is not installed on",
    async (scope, label) => {
      const app = scope === "person" ? "11" : "22";
      const { impl } = fake({
        ...both,
        [app]: { ...both[app], others: [{ id: 300, account: null }] },
      });

      const checks = await doctorGithub(secrets(), context(impl, scope));
      const [missing] = by(checks, `${label} on acme-libs: installation`);
      expect(missing).toMatchObject({ status: "fail" });
      expect(missing!.detail).toContain("is not installed on acme-libs, which owns acme-libs/kit");
      expect(missing!.fix).toContain("install it on acme-libs");
      expect(by(checks, `${label} on acme-libs: repositories`)).toEqual([]);
      expect(by(checks, `${label} on acme-example: repositories`)[0]).toMatchObject({
        status: "ok",
      });
    },
  );

  it.each(scopes)(
    "fails when the %s App's installation on one account misses a repository",
    async (scope, label) => {
      const app = scope === "person" ? "11" : "22";
      const other = { ...both[app].others[0]!, repos: [] };
      const { impl } = fake({ ...both, [app]: { ...both[app], others: [other] } });
      const checks = await doctorGithub(secrets(), context(impl, scope));
      expect(by(checks, `${label} on acme-libs: repositories`)[0]).toMatchObject({
        status: "fail",
        detail: "The installation does not cover acme-libs/kit.",
      });

      expect(by(checks, `${label} on acme-example: repositories`)[0]).toMatchObject({
        status: "ok",
      });
    },
  );

  it("checks each account's installation for its own permissions", async () => {
    const other = { ...both["11"].others[0]!, permissions: { ...WRITE, contents: "read" } };
    const { impl } = fake({ ...both, "11": { ...both["11"], others: [other] } });
    const checks = await doctorGithub(secrets(), context(impl, "person"));
    expect(by(checks, "GitHub App on acme-libs: permissions")[0]).toMatchObject({
      status: "fail",
    });

    expect(by(checks, "GitHub App on acme-example: permissions")[0]).toMatchObject({
      status: "ok",
    });
  });

  it("fails with the status when the installations cannot be listed", async () => {
    const { impl } = fake({ ...both, "22": { ...both["22"], others: { status: 500 } } });
    const checks = await doctorGithub(secrets(), context(impl, "office"));
    expect(by(checks, "Office GitHub App: installations")[0]).toMatchObject({
      status: "fail",
      detail: "GitHub answered 500 when listing the installations of acme-office.",
    });

    expect(by(checks, "Office GitHub App on acme-example: repositories")[0]).toMatchObject({
      status: "ok",
    });
  });

  it("flags a pinned installation on an account that owns none of the repositories, and still checks the others", async () => {
    const { impl } = fake({
      ...both,
      "22": {
        ...both["22"],
        installation: { account: "someone-else" },
        others: [
          ...both["22"].others,
          { id: 202, account: "acme-example", repos: ["acme-example/shop", "acme-example/infra"] },
        ],
      },
    });

    const checks = await doctorGithub(secrets(), context(impl, "office"));
    expect(by(checks, "Office GitHub App: installation")[0]).toMatchObject({
      status: "fail",
      key: "GH_OFFICE_APP_INSTALLATION_ID",
    });

    expect(by(checks, "Office GitHub App: installation")[0]!.detail).toContain(
      'belongs to "someone-else" but the repositories are owned by acme-example, acme-libs',
    );

    expect(failures(checks)).toHaveLength(1);
  });

  it("names no account for a pinned installation GitHub reports without one, when no repository is needed", async () => {
    const { impl } = fake(good);
    const f = (async (url: string | URL, init?: RequestInit) =>
      new URL(String(url)).pathname === "/app/installations/100"
        ? json(200, { repository_selection: "selected", permissions: WRITE })
        : impl(url, init)) as typeof fetch;

    const c = { ...ctx(f), person: { ...sam, repos: { shop: "read", infra: "read" } } as never };
    const checks = await doctorGithub(secrets(), c);
    expect(by(checks, "GitHub App: installation")[0]!.detail).toContain("an unknown account");
  });
});
