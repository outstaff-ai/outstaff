import { describe, expect, it } from "vitest";
import {
  appRoutes,
  build,
  expectPortError,
  officeSecrets,
  REPO,
  type Route,
} from "@outstaff/testing.github";

const get = (path: string, handler: Route["handler"]): Route => ({ method: "GET", path, handler });

const STATUSES = "/repos/acme/app/commits/abc/status";
const RUNS = "/repos/acme/app/commits/abc/check-runs";

const office = (extra: Route[]) => build([...appRoutes(), ...extra], officeSecrets).vcs;

describe("branchHead and contains", () => {
  it("refuses a branch GitHub reports no commit for", async () => {
    const vcs = office([
      get("/repos/acme/app/branches/main", () => ({ name: "main", protected: false })),
    ]);

    const e = await expectPortError(vcs.branchHead!(REPO, "main"), "not_found");
    expect(e.message).toContain("main");
  });

  it("counts identical and ahead as containing, behind and diverged as not", async () => {
    const answers = ["identical", "ahead", "behind", "diverged"];
    const vcs = office([
      get("/repos/acme/app/compare/:basehead", () => ({
        status: 200,
        body: { status: answers.shift() },
      })),
    ]);

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await vcs.contains!(REPO, "b", "a"));
    }

    expect(results).toEqual([true, true, false, false]);
  });
});

describe("checks with their workflows", () => {
  const checkRuns = (runs: unknown[]) => [
    get(RUNS, () => ({ check_runs: runs })),
    get(STATUSES, () => ({ statuses: [{ context: "lint", state: "success", target_url: null }] })),
  ];

  const run = (name: string, suite?: number) => ({
    name,
    status: "completed",
    conclusion: "success",
    html_url: `https://github.example/${name}`,
    ...(suite ? { check_suite: { id: suite } } : {}),
  });

  it("names the workflow of the runs in a workflow, and leaves the others", async () => {
    const vcs = office([
      ...checkRuns([run("deploy", 7), run("build", 8), run("other")]),
      get("/repos/acme/app/actions/runs", () => ({
        workflow_runs: [
          { name: "Deploy", check_suite_id: 7 },
          { name: null, check_suite_id: 8 },
          { name: "Orphan", check_suite_id: null },
        ],
      })),
    ]);

    const checks = await vcs.checks(REPO, "abc", { workflows: true });
    expect(checks.map((c) => [c.name, c.workflow])).toEqual([
      ["deploy", "Deploy"],
      ["build", undefined],
      ["other", undefined],
      ["lint", undefined],
    ]);
  });

  it("reads no workflow runs when no check run is in a suite", async () => {
    const vcs = office([...checkRuns([run("other")])]);
    const checks = await vcs.checks(REPO, "abc", { workflows: true });
    expect(checks.map((c) => c.workflow)).toEqual([undefined, undefined]);
  });

  it("keeps the checks without workflows when Actions cannot be read", async () => {
    const vcs = office([
      ...checkRuns([run("deploy", 7)]),
      get("/repos/acme/app/actions/runs", () => ({ status: 403, body: { message: "no" } })),
    ]);

    const checks = await vcs.checks(REPO, "abc", { workflows: true });
    expect(checks.map((c) => c.workflow)).toEqual([undefined, undefined]);
  });

  it("fails on any other error reading the workflow runs", async () => {
    const vcs = office([
      ...checkRuns([run("deploy", 7)]),
      get("/repos/acme/app/actions/runs", () => ({ status: 404, body: { message: "gone" } })),
    ]);

    const e = await expectPortError(vcs.checks(REPO, "abc", { workflows: true }), "not_found");
    expect(e.code).toBe("not_found");
  });
});
