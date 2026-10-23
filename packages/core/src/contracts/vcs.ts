import { expect, it } from "vitest";
import type { Vcs } from "../ports/index.js";
import type { VcsSeed } from "./seeds.js";
import {
  contractSuite,
  expectAbsoluteUrl,
  expectEventCursorBehaviour,
  expectPortError,
  requireCapability,
  requireSeed,
  type ContractSetupFn,
} from "./harness.js";

export function vcsContract(name: string, setup: ContractSetupFn<Vcs, VcsSeed>): void {
  contractSuite(`vcs contract: ${name}`, setup, (get) => {
    const repoOf = (t: Parameters<typeof requireSeed>[0], s: ReturnType<typeof get>) => {
      const repo = s.seed.repo;
      if (!repo) {
        t.skip("seed.repo not provided");
      }

      return repo!;
    };

    it("produces absolute links", async (t) => {
      expect.hasAssertions();
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      const repo = repoOf(t, s);
      for (const url of [
        s.subject.links.pr(repo, 1),
        s.subject.links.commit(repo, "abc123"),
        s.subject.links.thread(repo, 1, "t1"),
      ]) {
        expectAbsoluteUrl(url);
      }
    });

    it("opens, reads and lists pull requests", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      const repo = repoOf(t, s);
      const open = requireSeed(t, s.seed, "pullRequest");
      const pr = await open(repo, { title: "Add widget", author: { login: "sam", kind: "agent" } });
      const read = await s.subject.getPullRequest(repo, pr.number);
      expect(read).toMatchObject({ number: pr.number, title: "Add widget", state: "open" });
      expectAbsoluteUrl(read.url);
      expect(read.url).toBe(s.subject.links.pr(repo, pr.number));
      expect(
        (await s.subject.listPullRequests(repo, { author: "sam" })).map((p) => p.number),
      ).toContain(pr.number);

      expect(await s.subject.listPullRequests(repo, { author: "someone-else" })).toEqual([]);
    });

    it("reports not_found for an unknown pull request", async (t) => {
      expect.hasAssertions();
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      await expectPortError(s.subject.getPullRequest(repoOf(t, s), 99999), "not_found");
    });

    it("reports forbidden when the platform refuses", async (t) => {
      expect.hasAssertions();
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      await expectPortError(requireSeed(t, s.seed, "forbiddenCall")(), "forbidden");
    });

    it("waits for an unknown mergeability to settle", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      const repo = repoOf(t, s);
      const pr = await requireSeed(
        t,
        s.seed,
        "pullRequest",
      )(repo, { title: "Slow merge check", mergeable: ["unknown", "unknown", "clean"] });

      expect((await s.subject.getPullRequest(repo, pr.number)).mergeable).toBe("unknown");
      expect(
        (await s.subject.getPullRequest(repo, pr.number, { waitForMergeable: true })).mergeable,
      ).toBe("clean");
    });

    it("hides closed pull requests unless state is all", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      const repo = repoOf(t, s);
      const pr = await requireSeed(t, s.seed, "pullRequest")(repo, { title: "Done soon" });
      await requireSeed(t, s.seed, "merge")(repo, pr.number, "noor");
      expect((await s.subject.listPullRequests(repo)).map((p) => p.number)).not.toContain(
        pr.number,
      );

      expect(
        (await s.subject.listPullRequests(repo, { state: "all" })).find(
          (p) => p.number === pr.number,
        )?.state,
      ).toBe("merged");
    });

    it("lists checks for a commit", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      const repo = repoOf(t, s);
      const pr = await requireSeed(t, s.seed, "pullRequest")(repo, { title: "With checks" });
      await requireSeed(t, s.seed, "check")(repo, pr.head.sha, { name: "ci", status: "success" });
      const checks = await s.subject.checks(repo, pr.head.sha);
      expect(checks).toMatchObject([{ name: "ci", status: "success" }]);
      expectAbsoluteUrl(checks[0]!.url);
    });

    it("resolves a review thread only when the last comment is the caller's", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests", "vcs.reviewThreads");
      const repo = repoOf(t, s);
      const pr = await requireSeed(t, s.seed, "pullRequest")(repo, { title: "Reviewed" });
      const id = await requireSeed(t, s.seed, "thread")(repo, pr.number, {
        path: "src/a.ts",
        line: 3,
        comments: [
          { author: "noor", body: "rename this" },
          { author: "sam", body: "done" },
        ],
      });

      const threads = await s.subject.reviewThreads(repo, pr.number);
      expect(threads).toMatchObject([{ id, resolved: false, path: "src/a.ts", line: 3 }]);
      const refused = await s.subject.resolveThread(repo, id, "noor");
      expect(refused.resolved).toBe(false);
      expect(refused.reason).toBeTruthy();
      expect(await s.subject.resolveThread(repo, id, "sam")).toMatchObject({ resolved: true });
      expect((await s.subject.reviewThreads(repo, pr.number))[0]?.resolved).toBe(true);
      await expectPortError(s.subject.resolveThread(repo, "missing-thread", "sam"), "not_found");
    });

    it("resolves a thread as its own identity when no login is given", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests", "vcs.reviewThreads");
      const self = s.seed.selfLogin;
      if (!self) {
        t.skip();
        return;
      }

      const repo = repoOf(t, s);
      const pr = await requireSeed(t, s.seed, "pullRequest")(repo, { title: "Own login" });
      const thread = requireSeed(t, s.seed, "thread");
      const mine = await thread(repo, pr.number, {
        comments: [
          { author: "noor", body: "rename this" },
          { author: self, body: "done" },
        ],
      });

      const theirs = await thread(repo, pr.number, {
        comments: [
          { author: self, body: "done" },
          { author: "noor", body: "not yet" },
        ],
      });

      expect((await s.subject.resolveThread(repo, theirs)).resolved).toBe(false);
      expect(await s.subject.resolveThread(repo, mine)).toMatchObject({ resolved: true });
    });

    it("reports permissions and gates credentials on them", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      const repo = repoOf(t, s);
      const grant = requireSeed(t, s.seed, "permission");
      await grant(repo, "noor", "admin");
      await grant(repo, "sam", "write");
      await grant(repo, "kit", "read");
      expect(await s.subject.permission(repo, "noor")).toBe("admin");
      expect(await s.subject.permission(repo, "kit")).toBe("read");
      expect(await s.subject.permission(repo, "stranger")).toBe("none");
      const write = await s.subject.credentials("sam", repo, "write");
      expect(write.token).toBeTruthy();
      expect(Date.parse(write.expiresAt)).not.toBeNaN();
      await expectPortError(s.subject.credentials("kit", repo, "write"), "forbidden");
      await expect(s.subject.credentials("kit", repo, "read")).resolves.toMatchObject({
        token: expect.any(String),
      });

      await expectPortError(s.subject.credentials("stranger", repo, "read"), "forbidden");
    });

    it("pages events with an opaque cursor and no duplicates", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      const repo = repoOf(t, s);
      const pr = await requireSeed(t, s.seed, "pullRequest")(repo, { title: "Eventful" });
      const merge = requireSeed(t, s.seed, "merge");
      await expectEventCursorBehaviour(
        (cursor) => s.subject.events([repo], cursor),
        async () => void (await merge(repo, pr.number, "noor")),
      );

      const all = await s.subject.events([repo]);
      expect(all.events.map((e) => e.type)).toEqual(
        expect.arrayContaining(["pr.opened", "pr.merged"]),
      );

      expect(all.events.every((e) => e.number === pr.number && e.actor)).toBe(true);
    });
  });
}
