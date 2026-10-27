import { describe, expect, it } from "vitest";
import type { RepoRef } from "#/ports/index.js";
import { expectPortError, requireCapability, requireSeed } from "./harness.js";
import type { VcsCases, VcsSetup } from "./types.js";

/** What the subject does as its own identity: opening, updating, reviewing, replying, reacting and diffing. */
export function vcsCallerCases({ get, repoOf }: VcsCases): void {
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
      s: VcsSetup,
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

      expect(await s.subject.updatePullRequest(repo, pr.number, { base: "release" })).toMatchObject(
        {
          base: { ref: "release" },
        },
      );

      await expectPortError(s.subject.updatePullRequest(repo, 99999, { title: "x" }), "not_found");
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
      await expectPortError(s.subject.replyToThread(repo, pr.number, "missing", "x"), "not_found");

      expect((await s.subject.reviewThreads(repo, elsewhere.number))[0]?.comments).toHaveLength(1);
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
}
