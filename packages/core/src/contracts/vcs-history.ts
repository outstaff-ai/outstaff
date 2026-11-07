import { expect, it } from "vitest";
import { requireCapability, requireSeed } from "./harness.js";
import type { VcsCases } from "./types.js";

/** The default branch's later commits: its head, what a commit contains, and the workflow of a check. */
export function vcsHistoryCases({ get, repoOf }: VcsCases): void {
  it("reads the default branch's head and what a commit contains", async (t) => {
    const s = get();
    requireCapability(t, s, "vcs.pullRequests");
    if (!s.subject.branchHead || !s.subject.contains) {
      t.skip("branchHead and contains not implemented");
    }

    const repo = repoOf(t, s);
    const open = requireSeed(t, s.seed, "pullRequest");
    const merge = requireSeed(t, s.seed, "merge");
    const first = await merge(repo, (await open(repo, { title: "First" })).number, "rae");
    const second = await merge(repo, (await open(repo, { title: "Second" })).number, "rae");
    const head = await s.subject.branchHead!(repo, "main");
    expect(head).toBe(second.mergeCommitSha);
    expect(await s.subject.contains!(repo, head, first.mergeCommitSha!)).toBe(true);
    expect(await s.subject.contains!(repo, head, head)).toBe(true);
    expect(await s.subject.contains!(repo, first.mergeCommitSha!, head)).toBe(false);
  });

  it("names a check's workflow only when asked", async (t) => {
    const s = get();
    requireCapability(t, s, "vcs.pullRequests");
    const repo = repoOf(t, s);
    const pr = await requireSeed(t, s.seed, "pullRequest")(repo, { title: "Deployed" });
    await requireSeed(t, s.seed, "check")(repo, pr.head.sha, {
      name: "deploy",
      status: "success",
      workflow: "Deploy",
      log: { steps: [{ name: "Deploy", lines: ["ok"] }] },
    });

    const plain = await s.subject.checks(repo, pr.head.sha);
    expect(plain.find((c) => c.name === "deploy")?.workflow).toBeUndefined();
    const named = await s.subject.checks(repo, pr.head.sha, { workflows: true });
    expect(named.find((c) => c.name === "deploy")?.workflow).toBe("Deploy");
  });
}
