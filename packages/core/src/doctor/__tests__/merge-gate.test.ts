import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "#/config/parse.js";
import { createFakeVcs } from "#/fakes/vcs.js";
import { PortError } from "#/ports/errors.js";
import { mergeGateCheck, mergeGateChecks, mergeRepos } from "#/doctor/merge-gate.js";

const config = (merge: Record<string, unknown> | undefined, repos: Record<string, string> = {}) => {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [
      { name: "app", url: "github.com/acme/app", kind: "primary" },
      { name: "docs", url: "github.com/acme/docs", kind: "other" },
    ],
    people: [
      { handle: "sam", name: "Sam", role: "r", repos: { "kind:primary": "write", ...repos } },
    ],
    integrations: { chat: { adapter: "a" }, vcs: { adapter: "b" }, runtime: { adapter: "c" } },
    ...(merge ? { policies: { merge } } : {}),
  });

  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
};

const names = (c: ReturnType<typeof config>) => mergeRepos(c).map((r) => r.name);

describe("mergeRepos", () => {
  it("is none while merging is off, else the listed repos or every repo an agent can write", () => {
    expect(names(config(undefined))).toEqual([]);
    expect(names(config({ on_approval: true }))).toEqual(["app"]);
    expect(names(config({ on_approval: true }, { docs: "write" }))).toEqual(["app", "docs"]);
    expect(names(config({ on_approval: true, repos: ["docs"] }))).toEqual(["docs"]);
  });
});

describe("mergeGateCheck", () => {
  const req = (over: Record<string, unknown> = {}) => ({
    branch: "main",
    requiredChecks: [],
    requiredApprovals: 0,
    upToDate: false,
    ...over,
  });

  it("is an error when the branch requires neither checks nor a review", () => {
    expect(mergeGateCheck("app", req())).toMatchObject({
      name: "Merge gate of app",
      status: "fail",
      detail: expect.stringContaining("main requires no status check and no approving review"),
    });
  });

  it("warns when only one of them is required", () => {
    const checksOnly = mergeGateCheck("app", req({ requiredChecks: ["ci", "lint"] }));
    expect(checksOnly).toMatchObject({ status: "warn", fix: expect.stringContaining("review") });
    expect(checksOnly.detail).toContain("checks ci, lint");
    expect(checksOnly.detail).toContain("merge unreviewed");

    const reviewOnly = mergeGateCheck("app", req({ requiredApprovals: 2 }));
    expect(reviewOnly).toMatchObject({ status: "warn", fix: expect.stringContaining("checks") });
    expect(reviewOnly.detail).toContain("2 approving reviews");
  });

  it("is fine with both, and only warns on a partial read", () => {
    expect(mergeGateCheck("app", req({ requiredChecks: ["ci"], requiredApprovals: 1 }))).toEqual({
      name: "Merge gate of app",
      status: "ok",
      detail: "main requires checks ci and 1 approving review.",
    });

    const partial = mergeGateCheck("app", req({ partial: "the reviews." }));
    expect(partial.status).toBe("warn");
    expect(partial.detail).toContain("Not read: the reviews.");
  });
});

describe("mergeGateChecks", () => {
  it("reads each repo agents may merge through the vcs port", async () => {
    const vcs = createFakeVcs();
    await vcs.seed.protectBranch!(
      { host: "github.com", owner: "acme", name: "app" },
      { requiredChecks: ["ci"], requiredApprovals: 1 },
    );

    const checks = await mergeGateChecks(config({ on_approval: true }, { docs: "write" }), vcs);
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["Merge gate of app", "ok"],
      ["Merge gate of docs", "fail"],
    ]);
  });

  it("warns when the adapter cannot read requirements or the read fails", async () => {
    const team = config({ on_approval: true });
    const { mergeRequirements: _read, ...without } = createFakeVcs();
    expect(await mergeGateChecks(team, without)).toEqual([
      expect.objectContaining({ status: "warn", detail: expect.stringContaining("cannot read") }),
    ]);

    const failing = {
      ...createFakeVcs(),
      mergeRequirements: async () => {
        throw new PortError("forbidden", "no access");
      },
    };

    expect(await mergeGateChecks(team, failing)).toEqual([
      expect.objectContaining({ status: "warn", detail: expect.stringContaining("no access") }),
    ]);
  });
});
