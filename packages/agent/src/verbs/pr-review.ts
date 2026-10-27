import { PortError, type ReviewVerdict } from "@outstaff/core";
import { z } from "zod";
import { repoLabel, requireVcs } from "./support.js";
import { defineVerb, result } from "./define.js";
import { repoOrWorktree } from "./worktree.js";
import { body, bodyFile, commentsOf, number, repo, textOf } from "./pr-write-support.js";

/** The verdict each review flag stands for. */
const VERDICT_FLAGS = [
  ["approve", "approve"],
  ["requestChanges", "request_changes"],
  ["comment", "comment"],
] as const satisfies readonly (readonly [string, ReviewVerdict])[];

type VerdictFlags = Partial<Record<(typeof VERDICT_FLAGS)[number][0], boolean | undefined>>;

/** The one verdict the flags pick; none or several is refused. */
function chosenVerdict(input: VerdictFlags): ReviewVerdict {
  const chosen = VERDICT_FLAGS.filter(([flag]) => input[flag]).map(([, verdict]) => verdict);
  if (chosen.length !== 1) {
    throw new PortError("invalid", "Pass exactly one of approve, request-changes or comment.");
  }

  return chosen[0]!;
}

export const prReview = defineVerb({
  name: "pr.review",
  summary: "Submit a review: approve, request changes or comment.",
  description:
    "Submits a review of a pull request as you, with an optional summary and inline comments. Pass exactly one of approve, request-changes or comment. Inline comments come from comment-file, a JSON array of { path, line, body } on the new side of the diff. Refuses to review your own pull request.",
  input: z.strictObject({
    repo,
    number,
    approve: z.boolean().optional().describe("Approve the pull request."),
    requestChanges: z.boolean().optional().describe("Request changes."),
    comment: z.boolean().optional().describe("Comment without a verdict."),
    body,
    bodyFile,
    commentFile: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("JSON file with inline comments: an array of { path, line, body }."),
  }),
  args: ["number"],
  examples: [
    'ost pr review 42 --approve --body "Looks good."',
    "ost pr review 42 --request-changes --body-file .scratch/review.md --comment-file .scratch/inline.json",
  ],
  async run(env, input, ctx) {
    const verdict = chosenVerdict(input);
    const comments = commentsOf(env, ctx, input.commentFile) ?? [];
    const text = textOf(env, ctx, input, false) ?? "";
    if (verdict !== "approve" && !text.trim() && comments.length === 0) {
      throw new PortError("invalid", "A review that is not an approval needs a body or comments.");
    }

    const vcs = requireVcs(env);
    const ref = await repoOrWorktree(env, ctx, input.repo);
    await vcs.submitReview(ref, input.number, {
      verdict,
      body: text,
      ...(comments.length ? { comments } : {}),
    });

    const url = vcs.links.pr(ref, input.number);
    const inline = comments.length ? `, ${comments.length} inline` : "";
    return result(
      [
        `Submitted a review (${verdict.replace("_", " ")}${inline}) on ${repoLabel(ref)}#${input.number}.`,
        url,
      ],
      { verdict, comments: comments.length },
      [url],
    );
  },
});

export const prReply = defineVerb({
  name: "pr.reply",
  summary: "Reply to a review thread of a pull request.",
  description:
    "Replies to a review thread of the pull request as you. The thread id comes from pr threads; threads of other pull requests are refused. Resolve it afterwards with pr resolve.",
  input: z.strictObject({
    repo,
    number,
    thread: z.string().min(1).max(200).describe("Thread id from pr threads."),
    body,
    bodyFile,
  }),
  args: ["number", "thread"],
  examples: ['ost pr reply 42 PRT_abc123 --body "Renamed, thanks."'],
  async run(env, input, ctx) {
    const text = textOf(env, ctx, input, true)!;
    if (!text.trim()) {
      throw new PortError("invalid", "The reply is empty.");
    }

    const vcs = requireVcs(env);
    const ref = await repoOrWorktree(env, ctx, input.repo);
    await vcs.replyToThread(ref, input.number, input.thread, text);
    const pr = vcs.links.pr(ref, input.number);
    const thread = vcs.links.thread(ref, input.number, input.thread);
    return result(
      [`Replied to thread ${input.thread} on ${repoLabel(ref)}#${input.number}.`, thread],
      { thread: input.thread },
      [pr, thread],
    );
  },
});

export const prComment = defineVerb({
  name: "pr.comment",
  summary: "Comment on the conversation of a pull request.",
  description:
    "Posts a top-level comment on the pull request as you. Use it to answer a review summary or a conversation comment, quoting or linking what it answers. Answer an inline thread with pr reply instead.",
  input: z.strictObject({ repo, number, body, bodyFile }),
  args: ["number"],
  examples: ['ost pr comment 42 --body "> Please rename it.\n\nRenamed in the last push."'],
  async run(env, input, ctx) {
    const text = textOf(env, ctx, input, true)!;
    if (!text.trim()) {
      throw new PortError("invalid", "The comment is empty.");
    }

    const vcs = requireVcs(env);
    const ref = await repoOrWorktree(env, ctx, input.repo);
    const made = await vcs.commentOnPullRequest(ref, input.number, text);
    const url = vcs.links.pr(ref, input.number);
    return result([`Commented on ${repoLabel(ref)}#${input.number}: ${made.url}`, url], {}, [
      made.url,
      url,
    ]);
  },
});
