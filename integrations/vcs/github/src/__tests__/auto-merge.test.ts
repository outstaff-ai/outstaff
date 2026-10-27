import { describe, expect, it } from "vitest";
import {
  REPO,
  appRoutes,
  build,
  expectPortError,
  officeSecrets,
  ownSecrets,
  type Route,
} from "@outstaff/testing.github";

const agent = { ...officeSecrets, ...ownSecrets, OUTSTAFF_PERSON: "sam" };
const ROOT = "/repos/acme/app";

const routes = (repo: Record<string, unknown>, pull: Record<string, unknown> = {}): Route[] => [
  ...appRoutes(),
  {
    method: "GET",
    path: `${ROOT}/pulls/7`,
    handler: () => ({ number: 7, node_id: "PR_7", head: { ref: "f", sha: "abc" }, ...pull }),
  },
  { method: "GET", path: ROOT, handler: () => ({ default_branch: "main", ...repo }) },
  {
    method: "POST",
    path: "/graphql",
    handler: () => ({ data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_7" } } } }),
  },
  { method: "PUT", path: `${ROOT}/pulls/7/merge-async`, handler: () => ({ status: 202 }) },
];

describe("auto-merge", () => {
  it.each([
    [{}, "MERGE"],
    [{ allow_merge_commit: false }, "SQUASH"],
    [{ allow_merge_commit: false, allow_squash_merge: false }, "REBASE"],
  ])("turns it on with the repository's own method (%j -> %s)", async (repo, method) => {
    const { vcs, stub } = build(routes(repo), agent);
    await vcs.enableAutoMerge!(REPO, 7);
    const [call] = stub.called("POST", "/graphql");
    expect(call!.json.query).toContain("enablePullRequestAutoMerge");
    expect(call!.json.variables).toEqual({ id: "PR_7", method });
  });

  it("is unavailable when GitHub gives no node id", async () => {
    expect.hasAssertions();
    const { vcs } = build(routes({}, { node_id: undefined }), agent);
    await expectPortError(vcs.enableAutoMerge!(REPO, 7), "unavailable");
  });

  it("enqueues at the pull request's head through the async merge endpoint", async () => {
    const { vcs, stub } = build(routes({}), agent);
    await vcs.enqueue!(REPO, 7);
    expect(stub.called("PUT", `${ROOT}/pulls/7/merge-async`)[0]!.json).toEqual({
      merge_action: "merge_queue",
      sha: "abc",
    });
  });
});
