import { describe, expect, it } from "vitest";
import { doctorGithub } from "#/doctor.js";
import { by, ctx, fake, good, json, secrets, WRITE } from "./doctor-fake.js";

/** sam writes acme-example/shop, which has CI workflows. */
const withWorkflows = (permissions: object) =>
  fake({
    ...good,
    "11": { ...good["11"]!, installation: { permissions }, workflows: ["acme-example/shop"] },
  });

const workflows = (checks: { name: string; status: string; detail: string }[]) =>
  by(checks, "GitHub App: workflows");

describe("doctorGithub: workflows on a writable repository", () => {
  it("warns when the App lacks Workflows on a repository with .github/workflows/, naming the App and the repository", async () => {
    const checks = await doctorGithub(secrets(), ctx(withWorkflows(WRITE).impl));
    const [found] = workflows(checks);
    expect(found).toMatchObject({ status: "warn" });
    expect(found!.detail).toContain("acme-sam lacks workflows:write");
    expect(found!.detail).toContain("acme-example/shop has .github/workflows/");
    expect((found as { fix?: string }).fix).toContain('Workflows to "Read and write"');

    // A missing permission the role does not ask for is a warning, not a failure.
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  it("passes once the App has Workflows: write, without calling it surplus", async () => {
    const checks = await doctorGithub(
      secrets(),
      ctx(withWorkflows({ ...WRITE, workflows: "write" }).impl),
    );

    expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(workflows(checks)[0]).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("acme-example/shop"),
    });
  });

  it("checks nothing for a repository without workflows", async () => {
    const { impl, calls } = fake(good);
    const checks = await doctorGithub(secrets(), ctx(impl));
    expect(workflows(checks)).toEqual([]);
    expect(calls).toContain("GET /repos/acme-example/shop/contents/.github/workflows");
    // Only the repositories the person writes are looked at, and never through the office App.
    expect(calls.filter((c) => c.includes("/contents/"))).toHaveLength(1);
  });

  it("leaves it to the permission check when the role changes CI", async () => {
    const { impl, calls } = withWorkflows(WRITE);
    const checks = await doctorGithub(secrets(), {
      ...ctx(impl),
      roleCapabilities: ["vcs.pullRequests", "vcs.workflows"] as never,
    });

    expect(workflows(checks)).toEqual([]);
    expect(by(checks, "GitHub App: permissions")[0]).toMatchObject({ status: "fail" });
    expect(calls.filter((c) => c.includes("/contents/"))).toEqual([]);
  });

  it("looks at nothing when the installation token cannot be minted", async () => {
    const { impl, calls } = withWorkflows(WRITE);
    const f = (async (url: string | URL, init?: RequestInit) =>
      new URL(String(url)).pathname === "/app/installations/100/access_tokens"
        ? json(403, {})
        : impl(url, init)) as typeof fetch;

    const checks = await doctorGithub(secrets(), ctx(f));
    expect(workflows(checks)).toEqual([]);
    expect(calls.filter((c) => c.includes("/contents/"))).toEqual([]);
  });

  it("does not look for workflows for a person without a write grant", async () => {
    const { impl, calls } = withWorkflows(WRITE);
    await doctorGithub(secrets(), {
      ...ctx(impl),
      person: { handle: "sam", name: "Sam", repos: { shop: "read" } } as never,
    });

    expect(calls.filter((c) => c.includes("/contents/"))).toEqual([]);
  });
});
