import { describe, expect, it } from "vitest";
import { expectPortError, requireCapability, requireSeed } from "./harness.js";
import type { VcsCases } from "./types.js";

/** Review state, required checks, merge options and requirements, merging, auto-merge and the queue. */
export function vcsMergingCases({ get, repoOf }: VcsCases): void {
  describe("merging", () => {
    const setupMerge = async (t: Parameters<typeof requireSeed>[0], level: "write" | "read") => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests", "vcs.merge");
      const self = s.seed.selfLogin;
      if (!self) {
        t.skip("seed.selfLogin not provided");
      }

      const repo = repoOf(t, s);
      await requireSeed(t, s.seed, "permission")(repo, self!, level);
      await requireSeed(t, s.seed, "mergeSettings")(repo, { queue: false, methods: ["merge"] });
      const pr = await requireSeed(
        t,
        s.seed,
        "pullRequest",
      )(repo, { title: "To merge", author: { login: "noor", kind: "agent" } });

      return { s, repo, pr };
    };

    it("reports the submitted reviews and who is still asked", async (t) => {
      const { s, repo, pr } = await setupMerge(t, "write");
      await requireSeed(t, s.seed, "requestReview")(repo, pr.number, "ada");
      await requireSeed(t, s.seed, "requestReview")(repo, pr.number, "ben");
      await requireSeed(t, s.seed, "review")(repo, pr.number, "ben", "approved");
      const state = await s.subject.reviewState!(repo, pr.number);
      expect(state.requestedReviewers).toEqual(["ada"]);
      expect(state.reviews).toMatchObject([{ author: "ben", state: "approved" }]);
      expect(Number.isNaN(Date.parse(state.reviews[0]!.at))).toBe(false);
    });

    it("lists the required checks of a pull request with their status", async (t) => {
      const { s, repo, pr } = await setupMerge(t, "write");
      const check = requireSeed(t, s.seed, "check");
      await check(repo, pr.head.sha, { name: "ci", status: "success" });
      await check(repo, pr.head.sha, { name: "lint", status: "pending" });
      await requireSeed(t, s.seed, "requireCheck")(repo, pr.number, "ci");
      expect(await s.subject.requiredChecks!(repo, pr.number)).toMatchObject([
        { name: "ci", status: "success" },
      ]);
    });

    it("reports the merge queue and the allowed methods", async (t) => {
      const { s, repo, pr } = await setupMerge(t, "write");
      expect(await s.subject.mergeOptions!(repo, pr.base.ref)).toEqual({
        queue: false,
        methods: ["merge"],
      });

      await requireSeed(t, s.seed, "mergeSettings")(repo, { queue: true, methods: [] });
      expect(await s.subject.mergeOptions!(repo, pr.base.ref)).toEqual({
        queue: true,
        methods: [],
      });
    });

    it("reads the default branch's merge requirements, adding up every rule", async (t) => {
      const { s, repo, pr } = await setupMerge(t, "write");
      const protect = requireSeed(t, s.seed, "protectBranch");
      expect(await s.subject.mergeRequirements!(repo)).toEqual({
        branch: pr.base.ref,
        requiredChecks: [],
        requiredApprovals: 0,
        upToDate: false,
      });

      await protect(repo, { requiredChecks: ["ci"], requiredApprovals: 1 });
      await protect(repo, { requiredChecks: ["ci", "lint"], requiredApprovals: 2, upToDate: true });
      const read = await s.subject.mergeRequirements!(repo);
      expect({ ...read, requiredChecks: read.requiredChecks.toSorted() }).toEqual({
        branch: pr.base.ref,
        requiredChecks: ["ci", "lint"],
        requiredApprovals: 2,
        upToDate: true,
      });
    });

    it("merges at the checked head and refuses a head that moved", async (t) => {
      const { s, repo, pr } = await setupMerge(t, "write");
      await requireSeed(t, s.seed, "push")(repo, pr.number, "noor");
      await expectPortError(
        s.subject.mergePullRequest!(repo, pr.number, { method: "merge", sha: pr.head.sha }),
        "conflict",
      );

      const moved = await s.subject.getPullRequest(repo, pr.number);
      expect(
        await s.subject.mergePullRequest!(repo, pr.number, {
          method: "merge",
          sha: moved.head.sha,
        }),
      ).toEqual({ outcome: "merged" });

      expect((await s.subject.getPullRequest(repo, pr.number)).state).toBe("merged");
      await expectPortError(
        s.subject.mergePullRequest!(repo, pr.number, { method: "merge", sha: moved.head.sha }),
        "invalid",
      );
    });

    it("queues when the repository has a merge queue", async (t) => {
      const { s, repo, pr } = await setupMerge(t, "write");
      await requireSeed(t, s.seed, "mergeSettings")(repo, { queue: true });
      expect(
        await s.subject.mergePullRequest!(repo, pr.number, { method: "queue", sha: pr.head.sha }),
      ).toEqual({ outcome: "queued" });
    });

    it("refuses a method the repository does not allow", async (t) => {
      expect.hasAssertions();
      const { s, repo, pr } = await setupMerge(t, "write");
      await expectPortError(
        s.subject.mergePullRequest!(repo, pr.number, { method: "squash", sha: pr.head.sha }),
        "invalid",
      );
    });

    it("turns on auto-merge as itself, and the pull request says so", async (t) => {
      const { s, repo, pr } = await setupMerge(t, "write");
      expect(pr.autoMerge ?? false).toBe(false);
      await s.subject.enableAutoMerge!(repo, pr.number);
      expect((await s.subject.getPullRequest(repo, pr.number)).autoMerge).toBe(true);
    });

    it("adds a pull request to the merge queue where the repository has one", async (t) => {
      const { s, repo, pr } = await setupMerge(t, "write");
      await requireSeed(t, s.seed, "mergeSettings")(repo, { queue: true });
      await expect(s.subject.enqueue!(repo, pr.number)).resolves.toBeUndefined();
    });

    it("refuses auto-merge and the queue without a write grant", async (t) => {
      expect.hasAssertions();
      const { s, repo, pr } = await setupMerge(t, "write");
      await requireSeed(t, s.seed, "mergeSettings")(repo, { queue: true });
      await requireSeed(t, s.seed, "permission")(repo, s.seed.selfLogin!, "read");
      await expectPortError(s.subject.enableAutoMerge!(repo, pr.number), "forbidden");
      await expectPortError(s.subject.enqueue!(repo, pr.number), "forbidden");
    });

    it("refuses a merge without a write grant", async (t) => {
      expect.hasAssertions();
      const { s, repo, pr } = await setupMerge(t, "write");
      await requireSeed(t, s.seed, "permission")(repo, s.seed.selfLogin!, "read");
      await expectPortError(
        s.subject.mergePullRequest!(repo, pr.number, { method: "merge", sha: pr.head.sha }),
        "forbidden",
      );
    });
  });
}
