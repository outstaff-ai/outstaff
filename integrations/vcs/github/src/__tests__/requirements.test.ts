import { describe, expect, it } from "vitest";
import { REPO, appRoutes, build, expectPortError, type Route } from "@outstaff/testing.github";

const ROOT = "/repos/acme/app";

const routes = (branch: unknown, protection: Route["handler"], rules: unknown[] = []): Route[] => [
  ...appRoutes(),
  { method: "GET", path: ROOT, handler: () => ({ default_branch: "trunk" }) },
  { method: "GET", path: `${ROOT}/branches/trunk`, handler: () => branch },
  { method: "GET", path: `${ROOT}/branches/trunk/protection`, handler: protection },
  { method: "GET", path: `${ROOT}/rules/branches/trunk`, handler: () => rules },
];

const refused = () => ({
  status: 403,
  body: { message: "Resource not accessible by integration" },
});

describe("merge requirements", () => {
  it("reads classic protection and every ruleset rule of the default branch", async () => {
    const { vcs } = build(
      routes(
        { name: "trunk", protected: true },
        () => ({
          required_status_checks: { strict: true, contexts: ["ci"] },
          required_pull_request_reviews: { required_approving_review_count: 1 },
        }),
        [
          { type: "pull_request", parameters: { required_approving_review_count: 2 } },
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "ci" }, { context: "lint" }],
              strict_required_status_checks_policy: false,
            },
          },
          { type: "deletion" },
        ],
      ),
    );

    await expect(vcs.mergeRequirements!(REPO)).resolves.toEqual({
      branch: "trunk",
      requiredChecks: ["ci", "lint"],
      requiredApprovals: 2,
      upToDate: true,
    });
  });

  it("reads protection without checks or reviews, and rules without parameters, as asking nothing", async () => {
    const { vcs } = build(
      routes(
        { name: "trunk", protected: true },
        () => ({ required_status_checks: null, required_pull_request_reviews: null }),
        [{ type: "pull_request", parameters: {} }, { type: "required_status_checks" }],
      ),
    );

    await expect(vcs.mergeRequirements!(REPO)).resolves.toEqual({
      branch: "trunk",
      requiredChecks: [],
      requiredApprovals: 0,
      upToDate: false,
    });
  });

  it("falls back to the branch summary when classic protection is refused, and says what it missed", async () => {
    const summary = {
      name: "trunk",
      protected: true,
      protection: { enabled: true, required_status_checks: { contexts: ["ci"] } },
    };

    const { vcs } = build(routes(summary, refused));
    const read = await vcs.mergeRequirements!(REPO);
    expect(read).toMatchObject({ requiredChecks: ["ci"], requiredApprovals: 0, upToDate: false });
    expect(read.partial).toContain("Administration: read");

    const bare = build(routes({ name: "trunk", protected: true }, refused));
    await expect(bare.vcs.mergeRequirements!(REPO)).resolves.toMatchObject({
      requiredChecks: [],
      partial: expect.any(String),
    });
  });

  it("passes on any other failure of the protection read", async () => {
    expect.hasAssertions();
    const { vcs } = build(
      routes({ name: "trunk", protected: true }, () => ({ status: 500, body: { message: "x" } })),
    );

    await expectPortError(vcs.mergeRequirements!(REPO), "unavailable");
  });
});
