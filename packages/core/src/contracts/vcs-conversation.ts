import { expect, it } from "vitest";
import {
  expectAbsoluteUrl,
  expectEventCursorBehaviour,
  expectPortError,
  requireCapability,
  requireSeed,
} from "./harness.js";
import type { VcsCases } from "./types.js";

/** Review comments, the pull request conversation and the event feed. */
export function vcsConversationCases({ get, repoOf }: VcsCases): void {
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
}
