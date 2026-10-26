import { describe, expect, it } from "vitest";
import type { RepoRef, Vcs } from "../ports/index.js";
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

    it("reads the tail of the failed steps of a check", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      if (!s.subject.checkLog) {
        t.skip("checkLog not implemented");
      }

      const repo = repoOf(t, s);
      const pr = await requireSeed(t, s.seed, "pullRequest")(repo, { title: "Failing" });
      await requireSeed(t, s.seed, "check")(repo, pr.head.sha, {
        name: "ci",
        status: "failure",
        log: {
          steps: [
            { name: "Set up job", lines: ["ready"] },
            { name: "Run tests", failed: true, lines: ["one", "two", "three", "four"] },
          ],
        },
      });

      const check = (await s.subject.checks(repo, pr.head.sha)).find((c) => c.name === "ci")!;
      expect(check.logId).toBeTruthy();
      const log = await s.subject.checkLog!(repo, check.logId!, { tail: 2 });
      // A host may add its own marker lines, so the lines are counted, not compared.
      expect(log.failedSteps.map((st) => st.name)).toEqual(["Run tests"]);
      expect(log.failedSteps[0]!.lines).toHaveLength(2);
      expect(log.failedSteps[0]!.omitted).toBeGreaterThanOrEqual(2);
      await expectPortError(s.subject.checkLog!(repo, "no-such-log"), "not_found");
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

    describe("acting as the caller", () => {
      // The subject's own identity is seed.selfLogin; the default branch is "main".
      const setupSelf = async (t: Parameters<typeof requireSeed>[0], level: "write" | "read") => {
        const s = get();
        requireCapability(t, s, "vcs.pullRequests");
        const self = s.seed.selfLogin;
        if (!self) {
          t.skip("seed.selfLogin not provided");
        }

        const repo = repoOf(t, s);
        await requireSeed(t, s.seed, "permission")(repo, self!, level);
        return { s, repo, self: self! };
      };

      const otherPr = async (
        t: Parameters<typeof requireSeed>[0],
        s: ReturnType<typeof get>,
        repo: RepoRef,
        title: string,
      ) =>
        requireSeed(
          t,
          s.seed,
          "pullRequest",
        )(repo, { title, author: { login: "noor", kind: "agent" } });

      it("opens a pull request as the caller, a draft on request, from a pushed branch", async (t) => {
        const { s, repo, self } = await setupSelf(t, "write");
        const pr = await s.subject.openPullRequest(repo, {
          head: "feat/widget",
          title: "Add widget",
          body: "Closes #1",
          draft: true,
        });

        expect(pr).toMatchObject({
          title: "Add widget",
          body: "Closes #1",
          draft: true,
          state: "open",
          head: { ref: "feat/widget" },
          base: { ref: "main" },
        });

        expect(pr.url).toBe(s.subject.links.pr(repo, pr.number));
        expect(await s.subject.getPullRequest(repo, pr.number)).toMatchObject({
          title: "Add widget",
          draft: true,
        });

        const opened = (await s.subject.events([repo])).events.find(
          (e) => e.type === "pr.opened" && e.number === pr.number,
        );

        expect(opened?.actor.replace(/\[bot\]$/, "")).toBe(self);
        const based = await s.subject.openPullRequest(repo, {
          head: "feat/second",
          base: "release",
          title: "Backport",
          body: "",
        });

        expect(based).toMatchObject({ base: { ref: "release" }, draft: false });
      });

      it("refuses to open a pull request from the default branch", async (t) => {
        expect.hasAssertions();
        const { s, repo } = await setupSelf(t, "write");
        await expectPortError(
          s.subject.openPullRequest(repo, { head: "main", title: "Oops", body: "" }),
          "invalid",
        );
      });

      it("refuses every write without a write grant", async (t) => {
        const { s, repo } = await setupSelf(t, "write");
        const pr = await otherPr(t, s, repo, "Theirs");
        const id = await requireSeed(t, s.seed, "thread")(repo, pr.number, {
          comments: [{ author: "noor", body: "rename this" }],
        });

        await requireSeed(t, s.seed, "permission")(repo, s.seed.selfLogin!, "read");
        await expectPortError(
          s.subject.openPullRequest(repo, { head: "feat/x", title: "No", body: "" }),
          "forbidden",
        );

        await expectPortError(
          s.subject.updatePullRequest(repo, pr.number, { title: "No" }),
          "forbidden",
        );

        await expectPortError(s.subject.replyToThread(repo, pr.number, id, "no"), "forbidden");
        expect((await s.subject.getPullRequest(repo, pr.number)).title).toBe("Theirs");
      });

      it("updates title, body, base and draft state, both ways", async (t) => {
        const { s, repo } = await setupSelf(t, "write");
        const pr = await s.subject.openPullRequest(repo, {
          head: "feat/update",
          title: "Before",
          body: "old",
          draft: true,
        });

        const ready = await s.subject.updatePullRequest(repo, pr.number, {
          title: "After",
          body: "new",
          draft: false,
        });

        expect(ready).toMatchObject({ title: "After", body: "new", draft: false });
        expect(ready.base.ref).toBe("main");
        expect(await s.subject.updatePullRequest(repo, pr.number, { draft: true })).toMatchObject({
          title: "After",
          draft: true,
        });

        expect(
          await s.subject.updatePullRequest(repo, pr.number, { base: "release" }),
        ).toMatchObject({
          base: { ref: "release" },
        });

        await expectPortError(
          s.subject.updatePullRequest(repo, 99999, { title: "x" }),
          "not_found",
        );
      });

      it("submits reviews with each verdict, with a read grant and inline comments", async (t) => {
        const { s, repo, self } = await setupSelf(t, "read");
        const pr = await otherPr(t, s, repo, "To review");
        await s.subject.submitReview(repo, pr.number, {
          verdict: "request_changes",
          body: "Needs work",
          comments: [{ path: "src/a.ts", line: 3, body: "rename this" }],
        });

        await s.subject.submitReview(repo, pr.number, { verdict: "comment", body: "A thought" });
        await s.subject.submitReview(repo, pr.number, { verdict: "approve", body: "Good now" });
        const reviews = (await s.subject.events([repo])).events.filter(
          (e) => e.type === "pr.review_submitted" && e.number === pr.number,
        );

        expect(reviews.map((e) => e.data["state"])).toEqual([
          "changes_requested",
          "commented",
          "approved",
        ]);

        expect(reviews.every((e) => e.actor.replace(/\[bot\]$/, "") === self)).toBe(true);
        await expectPortError(
          s.subject.submitReview(repo, 99999, { verdict: "approve", body: "" }),
          "not_found",
        );
      });

      it("refuses reviewing one's own pull request", async (t) => {
        expect.hasAssertions();
        const { s, repo } = await setupSelf(t, "write");
        const pr = await s.subject.openPullRequest(repo, {
          head: "feat/mine",
          title: "Mine",
          body: "",
        });

        await expectPortError(
          s.subject.submitReview(repo, pr.number, { verdict: "approve", body: "lgtm" }),
          "forbidden",
        );
      });

      it("replies to a thread of that pull request only", async (t) => {
        const { s, repo, self } = await setupSelf(t, "write");
        const pr = await otherPr(t, s, repo, "Threaded");
        const elsewhere = await otherPr(t, s, repo, "Elsewhere");
        const thread = requireSeed(t, s.seed, "thread");
        const id = await thread(repo, pr.number, {
          path: "src/a.ts",
          line: 3,
          comments: [{ author: "noor", body: "rename this" }],
        });

        const other = await thread(repo, elsewhere.number, {
          comments: [{ author: "noor", body: "and this" }],
        });

        await s.subject.replyToThread(repo, pr.number, id, "done");
        const last = (await s.subject.reviewThreads(repo, pr.number))
          .find((x) => x.id === id)
          ?.comments.at(-1);

        expect(last?.body).toBe("done");
        expect(last?.author.replace(/\[bot\]$/, "")).toBe(self);
        await expectPortError(s.subject.replyToThread(repo, pr.number, other, "x"), "not_found");
        await expectPortError(
          s.subject.replyToThread(repo, pr.number, "missing", "x"),
          "not_found",
        );

        expect((await s.subject.reviewThreads(repo, elsewhere.number))[0]?.comments).toHaveLength(
          1,
        );
      });

      it("comments on the pull request conversation with a write grant", async (t) => {
        const { s, repo, self } = await setupSelf(t, "write");
        const pr = await otherPr(t, s, repo, "Talked about");
        const made = await s.subject.commentOnPullRequest(repo, pr.number, "Thanks, done.");
        expect(made.url).toMatch(/^https?:\/\//);
        const comments = (await s.subject.events([repo])).events.filter(
          (e) => e.type === "pr.comment" && e.number === pr.number && e.data["kind"] === "comment",
        );

        expect(comments.map((e) => e.data["body"])).toEqual(["Thanks, done."]);
        expect(comments[0]?.actor.replace(/\[bot\]$/, "")).toBe(self);
        await expectPortError(s.subject.commentOnPullRequest(repo, 99999, "x"), "not_found");
      });

      it("reacts to a conversation comment and to an inline comment, once per reaction", async (t) => {
        const { s, repo, self } = await setupSelf(t, "write");
        requireCapability(t, s, "vcs.reactions");
        const reactions = requireSeed(t, s.seed, "reactions");
        const pr = await otherPr(t, s, repo, "Reacted to");
        const commentId = await requireSeed(t, s.seed, "comment")(repo, pr.number, "dana", "Hm?");
        const reviewId = await requireSeed(t, s.seed, "review")(
          repo,
          pr.number,
          "dana",
          "commented",
          "",
          [{ path: "src/a.ts", line: 2, body: "rename" }],
        );

        const [inline] = await s.subject.reviewComments(repo, pr.number, reviewId);
        const targets = [
          { kind: "conversation_comment", id: commentId },
          { kind: "inline_comment", id: inline!.id },
        ] as const;

        for (const target of targets) {
          await s.subject.react(repo, target, "eyes");
          await s.subject.react(repo, target, "eyes");
          const found = (await reactions(repo, target)).map((r) => [
            r.user.replace(/\[bot\]$/, ""),
            r.reaction,
          ]);

          expect(found).toEqual([[self, "eyes"]]);
        }

        await expectPortError(
          s.subject.react(repo, { kind: "conversation_comment", id: "99999999" }, "eyes"),
          "not_found",
        );

        await expectPortError(
          s.subject.react(repo, { kind: "inline_comment", id: "99999999" }, "eyes"),
          "not_found",
        );
      });

      it("returns the unified diff with a read grant", async (t) => {
        const { s, repo } = await setupSelf(t, "read");
        const pr = await otherPr(t, s, repo, "Diffed");
        const diff = await s.subject.diff(repo, pr.number);
        expect(diff).toContain("diff --git");
        await expectPortError(s.subject.diff(repo, 99999), "not_found");
      });
    });

    it("lists the inline comments of a submitted review, each with its thread", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests", "vcs.reviewThreads");
      const repo = repoOf(t, s);
      const pr = await requireSeed(t, s.seed, "pullRequest")(repo, { title: "Batch reviewed" });
      const reviewId = await requireSeed(t, s.seed, "review")(
        repo,
        pr.number,
        "noor",
        "changes_requested",
        "Two things",
        [
          { path: "src/a.ts", line: 3, body: "rename this" },
          { path: "src/b.ts", line: 7, body: "and this" },
        ],
      );

      const threads = await s.subject.reviewThreads(repo, pr.number);
      const comments = await s.subject.reviewComments(repo, pr.number, reviewId);
      expect(comments.map((c) => [c.path, c.line, c.body])).toEqual([
        ["src/a.ts", 3, "rename this"],
        ["src/b.ts", 7, "and this"],
      ]);

      expect(comments.map((c) => c.threadId)).toEqual(threads.map((th) => th.id));
      for (const c of comments) {
        expectAbsoluteUrl(c.url!);
      }

      await expectPortError(s.subject.reviewComments(repo, pr.number, "nope"), "not_found");
    });

    it("lists the conversation oldest first: comments and review summaries", async (t) => {
      const s = get();
      requireCapability(t, s, "vcs.pullRequests");
      const repo = repoOf(t, s);
      const seed = s.seed;
      const pr = await requireSeed(t, seed, "pullRequest")(repo, { title: "Talked through" });
      const comment = requireSeed(t, seed, "comment");
      const review = requireSeed(t, seed, "review");
      await comment(repo, pr.number, "dana", "Should we cache this?");
      await review(repo, pr.number, "noor", "changes_requested", "Needs a test");
      // A review that only wraps inline comments has no summary of its own.
      await review(repo, pr.number, "noor", "commented", "", [
        { path: "src/a.ts", line: 1, body: "rename" },
      ]);

      await comment(repo, pr.number, "sam", "Yes, I will add one.");

      const all = await s.subject.conversation(repo, pr.number);
      expect(all.map((e) => [e.kind, e.author.replace(/\[bot\]$/, ""), e.body, e.state])).toEqual([
        ["comment", "dana", "Should we cache this?", undefined],
        ["review", "noor", "Needs a test", "changes_requested"],
        ["comment", "sam", "Yes, I will add one.", undefined],
      ]);

      expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
      for (const e of all) {
        expectAbsoluteUrl(e.url);
        expect(Number.isNaN(Date.parse(e.at))).toBe(false);
      }

      const times = all.map((e) => Date.parse(e.at));
      expect(times).toEqual([...times].sort((a, b) => a - b));

      const last = await s.subject.conversation(repo, pr.number, { limit: 2 });
      expect(last.map((e) => e.id)).toEqual(all.slice(1).map((e) => e.id));

      const since = await s.subject.conversation(repo, pr.number, { since: all[2]!.at });
      expect(since.map((e) => e.id)).toEqual(all.slice(2).map((e) => e.id));

      await expectPortError(s.subject.conversation(repo, 99999), "not_found");
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
