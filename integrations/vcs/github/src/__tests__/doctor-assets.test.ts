import { describe, expect, it } from "vitest";
import { doctorGithub } from "#/doctor.js";
import { by, ctx, fake, good, secrets } from "./doctor-fake.js";

/** sam's own App, with the rule types the shop repository's rulesets apply to the assets branch. */
const withRules = (rules: Record<string, string[]>, assets: string[] = []) =>
  fake({ ...good, "11": { ...good["11"]!, rules, assets } });

const assets = (checks: { name: string; status: string; detail: string }[]) =>
  by(checks, "GitHub App: assets branch");

describe("doctorGithub: the assets branch", () => {
  it("passes when no ruleset stops the App creating or pushing the branch", async () => {
    const { impl, calls } = withRules({ "acme-example/shop": ["deletion", "non_fast_forward"] });
    const checks = await doctorGithub(secrets(), ctx(impl));
    expect(assets(checks)).toEqual([
      expect.objectContaining({
        status: "ok",
        detail: "acme-sam can create and push outstaff-assets on acme-example/shop.",
      }),
    ]);

    // The office App is not asked, and the read-only repository is not looked at.
    expect(calls.filter((c) => c.includes("/rules/"))).toEqual([
      "GET /repos/acme-example/shop/rules/branches/outstaff-assets",
    ]);
  });

  it("warns about rules that restrict updates or ask for a pull request, saying what to allow", async () => {
    const { impl } = withRules({ "acme-example/shop": ["update", "pull_request", "deletion"] });
    const [found] = assets(await doctorGithub(secrets(), ctx(impl)));
    expect(found).toMatchObject({ status: "warn" });
    expect(found!.detail).toContain("acme-example/shop (update, pull_request)");
    expect((found as { fix?: string }).fix).toContain("Exclude refs/heads/outstaff-assets");
    expect((found as { fix?: string }).fix).toContain("acme-sam App to their bypass list");
  });

  it("warns about restricted creation only while the branch does not exist", async () => {
    const before = withRules({ "acme-example/shop": ["creation"] });
    expect(assets(await doctorGithub(secrets(), ctx(before.impl)))[0]).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("acme-example/shop (creation)"),
    });

    const after = withRules({ "acme-example/shop": ["creation"] }, ["acme-example/shop"]);
    expect(assets(await doctorGithub(secrets(), ctx(after.impl)))[0]).toMatchObject({
      status: "ok",
    });
  });

  it("checks the branch the options name, and the default for options that do not parse", async () => {
    const { impl, calls } = withRules({ "acme-example/shop": [] });
    const named = await doctorGithub(secrets(), {
      ...ctx(impl),
      options: { assetsBranch: "team/images" },
    });

    expect(assets(named)[0]!.detail).toContain("team/images");
    expect(calls).toContain("GET /repos/acme-example/shop/rules/branches/team/images");
    const fallback = await doctorGithub(secrets(), { ...ctx(impl), options: { assetsBranch: 3 } });
    expect(assets(fallback)[0]!.detail).toContain("outstaff-assets");
  });

  it("says nothing when the rules cannot be read, come back in another shape, or the token cannot be minted", async () => {
    expect(assets(await doctorGithub(secrets(), ctx(fake(good).impl)))).toEqual([]);
    const { impl } = withRules({ "acme-example/shop": ["update"] });
    const f = (async (url: string | URL, init?: RequestInit) =>
      new URL(String(url)).pathname === "/app/installations/100/access_tokens"
        ? new Response("{}", { status: 403 })
        : impl(url, init)) as typeof fetch;

    expect(assets(await doctorGithub(secrets(), ctx(f)))).toEqual([]);
    const odd = (async (url: string | URL, init?: RequestInit) =>
      new URL(String(url)).pathname.includes("/rules/branches/")
        ? new Response("{}", { status: 200 })
        : impl(url, init)) as typeof fetch;

    expect(assets(await doctorGithub(secrets(), ctx(odd)))).toEqual([]);
  });

  it("checks nothing for a person without a write grant", async () => {
    const { impl, calls } = withRules({ "acme-example/shop": ["update"] });
    await doctorGithub(secrets(), {
      ...ctx(impl),
      person: { handle: "sam", name: "Sam", repos: { shop: "read" } } as never,
    });

    expect(calls.filter((c) => c.includes("/rules/"))).toEqual([]);
  });
});
