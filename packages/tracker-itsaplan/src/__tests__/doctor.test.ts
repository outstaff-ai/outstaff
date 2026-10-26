import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { doctorItsaplan } from "../doctor.js";

const team = {
  team: { name: "acme" },
  repos: [],
  people: [],
  integrations: {
    tracker: { adapter: "itsaplan", url: "https://tracker.example", project: "ACME" },
  },
} as unknown as TeamConfig;

const ctx = (
  respond: (url?: string) => Response,
  tracker?: string,
  scope: "person" | "office" = "person",
): DeriveContext => ({
  team,
  scope,
  options: { url: "https://tracker.example", project: "ACME" },
  ...(scope === "person"
    ? {
        person: {
          handle: "sam",
          name: "Sam",
          ...(tracker ? { identities: { tracker } } : {}),
        } as never,
      }
    : {}),
  fetch: (async (url: string | URL) => respond(String(url))) as unknown as typeof fetch,
  now: () => new Date(),
  warn: () => {},
});

const project = {
  project: { id: 1, key: "ACME", ref: "acme.ACME", name: "Acme", teamRef: "acme" },
};

/** Answers `/me` with `body` and the project with a workspace named `acme`. */
const me =
  (body: unknown, status = 200, proj: unknown = project) =>
  (url?: string) =>
    new Response(JSON.stringify(String(url).includes("/projects/") ? proj : body), {
      status: String(url).includes("/projects/") ? 200 : status,
    });

const secrets = (extra: Record<string, string> = {}) =>
  envSecretSource({ ITSAPLAN_API_KEY: "fake-key", ...extra }, "/nonexistent");

describe("doctorItsaplan", () => {
  it("passes when the key works and the member matches", async () => {
    const checks = await doctorItsaplan(
      secrets({ ITSAPLAN_MEMBER_ID: "17" }),
      ctx(me({ id: 17, username: "sam" }), "sam"),
    );

    expect(checks.map((c) => c.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("fails when the call is rejected", async () => {
    const [check] = await doctorItsaplan(secrets(), ctx(me({ error: "bad key" }, 401), "sam"));
    expect(check).toMatchObject({ status: "fail", key: "ITSAPLAN_API_KEY" });
    expect(JSON.stringify(check)).not.toContain("fake-key");
  });

  it("fails when identities.tracker or the member id names another member", async () => {
    const checks = await doctorItsaplan(
      secrets({ ITSAPLAN_MEMBER_ID: "99" }),
      ctx(me({ id: 17, username: "sam" }), "ada"),
    );

    expect(checks.find((c) => c.key === "ITSAPLAN_MEMBER_ID")!.detail).toBe(
      'ITSAPLAN_MEMBER_ID is "99" but the API key belongs to member 17.',
    );

    expect(checks.find((c) => c.name === "Its a Plan identity")!.detail).toContain(
      'identities.tracker is "ada"',
    );
  });

  it("accepts the member id as identities.tracker and warns when it is missing", async () => {
    expect((await doctorItsaplan(secrets(), ctx(me({ id: 17 }), "17"))).at(-1)!.status).toBe("ok");

    expect((await doctorItsaplan(secrets(), ctx(me({ id: 17 })))).at(-1)!.status).toBe("warn");
  });

  it("prints the member id to put in team.yaml when identities.tracker is missing", async () => {
    const checks = await doctorItsaplan(secrets(), ctx(me({ id: 17 })));
    expect(checks.at(-1)).toMatchObject({
      status: "warn",
      fix: "Set identities.tracker to 17 for sam in team.yaml.",
    });
  });

  it("does not compare an identity for the office", async () => {
    const checks = await doctorItsaplan(secrets(), ctx(me({ id: 17 }), undefined, "office"));
    expect(checks).toHaveLength(2);
  });

  it("prints one issue link and one doc link with the workspace", async () => {
    const checks = await doctorItsaplan(secrets(), ctx(me({ id: 17 }), "17"));
    expect(checks.find((c) => c.name === "Its a Plan links")).toMatchObject({
      status: "ok",
      detail:
        "Workspace acme. Issue link https://tracker.example/acme/issue/ACME-1, doc link https://tracker.example/acme/ACME/docs/1. Open them to check.",
    });
  });

  it("fails when the workspace cannot be determined", async () => {
    const noTeam = { project: { id: 1, key: "ACME", ref: "ACME", name: "Acme" } };
    const checks = await doctorItsaplan(secrets(), ctx(me({ id: 17 }, 200, noTeam), "17"));
    expect(checks.find((c) => c.name === "Its a Plan links")).toMatchObject({ status: "fail" });
  });

  it("does nothing without a key", async () => {
    expect(await doctorItsaplan(envSecretSource({}, "/nonexistent"), ctx(me({})))).toEqual([]);
  });
});
