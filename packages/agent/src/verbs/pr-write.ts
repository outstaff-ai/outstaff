import {
  createTicketLinker,
  PortError,
  policyValue,
  type ReviewComment,
  type ReviewVerdict,
} from "@outstaff/core";
import { z } from "zod";
import { repoLabel, requireVcs } from "./support.js";
import { readInputFile } from "./files.js";
import { mentionGuard } from "./mentions.js";
import { defineVerb, result, type AgentEnv, type VerbContext } from "./types.js";
import { currentBranch, repoOrWorktree } from "./worktree.js";

const repo = z
  .string()
  .min(1)
  .max(300)
  .optional()
  .describe(
    "Repository: its name in team.yaml or host/owner/name. Default: the repository the current worktree's origin points at.",
  );

const number = z.number().int().min(1).describe("Pull request number.");

const body = z.string().max(65_000).optional().describe("Text, Markdown. Or pass body-file.");

const bodyFile = z
  .string()
  .min(1)
  .max(1000)
  .optional()
  .describe(
    "File with the text, Markdown (in the worktree or your scratch directory; the read policy applies). Use it for long text.",
  );

/** Mentions guarded, then ticket keys linked the way the code host wants (wrong links only; GitHub autolinks bare keys). */
function guarded(env: AgentEnv, text: string): string {
  return createTicketLinker(env.team, env.tracker).format(
    mentionGuard(env.team).apply(text),
    "host",
  );
}

/** The text from `body` or `body-file`, with @-mentions guarded and ticket links fixed; `undefined` when neither is given and it is optional. */
function textOf(
  env: AgentEnv,
  ctx: VerbContext,
  input: { body?: string | undefined; bodyFile?: string | undefined },
  required: boolean,
): string | undefined {
  if (input.body !== undefined && input.bodyFile !== undefined) {
    throw new PortError("invalid", "Pass either body or body-file, not both.");
  }

  if (input.bodyFile !== undefined) {
    return guarded(env, readInputFile(env, ctx, input.bodyFile, "body file"));
  }

  if (input.body === undefined && required) {
    throw new PortError("invalid", "Pass body or body-file.");
  }

  return input.body === undefined ? undefined : guarded(env, input.body);
}

const inlineComments = z
  .array(
    z.strictObject({
      path: z.string().min(1).max(1000),
      line: z.number().int().min(1),
      body: z.string().min(1).max(65_000),
    }),
  )
  .max(100);

function commentsOf(
  env: AgentEnv,
  ctx: VerbContext,
  file: string | undefined,
): ReviewComment[] | undefined {
  if (file === undefined) {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readInputFile(env, ctx, file, "comment file"));
  } catch (e) {
    if (e instanceof PortError) {
      throw e;
    }

    throw new PortError("invalid", `Comment file ${file} is not JSON.`, { cause: e });
  }

  const parsed = inlineComments.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new PortError(
      "invalid",
      `Comment file ${file} must be a JSON array of { path, line, body }: ${problems.join("; ")}`,
    );
  }

  return parsed.data.map((c) => ({ ...c, body: guarded(env, c.body) }));
}

/**
 * With one pull request per ticket (the default), a pull request for a ticket that already has one, open or merged,
 * is refused. The office says which ticket the new one would link to, by the rule it links existing ones with, and
 * what that ticket has; a closed pull request that never merged does not count.
 */
async function oneForTicket(
  env: AgentEnv,
  draft: { headRef: string; title: string; body: string },
): Promise<void> {
  if (!env.office || policyValue(env.team.policies, "tickets.prs_per_ticket") !== "one") {
    return;
  }

  const { ticket, prs } = await env.office.ticketPrs(draft);
  const existing = prs.filter((p) => p.state !== "closed");
  if (!ticket || existing.length === 0) {
    return;
  }

  const named = existing
    .map((p) => `${p.ref} (${p.state === "merged" ? "merged" : "open"})${p.url ? ` ${p.url}` : ""}`)
    .join(", ");

  throw new PortError(
    "conflict",
    `${ticket} already has ${existing.length === 1 ? "a pull request" : "pull requests"}: ${named}. One ticket takes one pull request, because outstaff moves the ticket to done when its pull request merges. Split the work: create a ticket for this part with \`ost ticket create --parent ${ticket} --title "..."\`, then open the pull request for that new ticket, with \`Closes <new ticket>\` in its body. To change the pull request ${ticket} already has, use \`ost pr update\` or push to its branch.`,
  );
}

export const prOpen = defineVerb({
  name: "pr.open",
  summary: "Open a pull request from a pushed branch.",
  description:
    "Opens a pull request as you. The head defaults to the branch checked out in your worktree, the base to the repository's default branch and the repository to the worktree's origin. Refuses to open from the default branch. Push the branch first. Pass draft to open it as a draft. A ticket takes one pull request: it is refused when the ticket the pull request would link to (a closing keyword in the body, the branch, the title) already has one, open or merged; split the work into a sub-ticket with ticket create --parent and open the pull request for that ticket. A team can allow several with policies.tickets.prs_per_ticket: many.",
  input: z.strictObject({
    repo,
    head: z
      .string()
      .min(1)
      .max(250)
      .optional()
      .describe("Branch with the changes. Default: the branch checked out in the worktree."),
    base: z
      .string()
      .min(1)
      .max(250)
      .optional()
      .describe("Branch to merge into. Default: the repository's default branch."),
    title: z.string().min(1).max(256).describe("Pull request title."),
    body,
    bodyFile,
    draft: z.boolean().default(false).describe("Open as a draft."),
  }),
  args: [],
  examples: [
    'ost pr open --title "feat(cart): add coupons" --body-file .scratch/pr.md',
    'ost pr open --repo shop --head feat/coupons --title "feat(cart): add coupons" --body "Closes #12" --draft',
  ],
  async run(env, input, ctx) {
    const vcs = requireVcs(env);
    const ref = await repoOrWorktree(env, ctx, input.repo);
    const head = input.head ?? (await currentBranch(ctx));
    const text = textOf(env, ctx, input, true) ?? "";
    await oneForTicket(env, { headRef: head, title: input.title, body: text });
    const pr = await vcs.openPullRequest(ref, {
      head,
      title: input.title,
      body: text,
      draft: input.draft,
      ...(input.base ? { base: input.base } : {}),
    });

    const url = vcs.links.pr(ref, pr.number);
    return result(
      [
        `Opened ${repoLabel(ref)}#${pr.number}${pr.draft ? " (draft)" : ""}: ${pr.title}`,
        `${pr.head.ref} -> ${pr.base.ref}`,
        url,
      ],
      { pr },
      [url],
    );
  },
});

export const prUpdate = defineVerb({
  name: "pr.update",
  summary: "Change the title, body, base or draft state of a pull request.",
  description:
    "Updates a pull request as you. Pass only what changes. draft turns it into a draft, ready marks a draft ready for review.",
  input: z.strictObject({
    repo,
    number,
    title: z.string().min(1).max(256).optional().describe("New title."),
    body,
    bodyFile,
    base: z.string().min(1).max(250).optional().describe("New base branch."),
    draft: z.boolean().optional().describe("Convert to a draft."),
    ready: z.boolean().optional().describe("Mark a draft ready for review."),
  }),
  args: ["number"],
  examples: [
    'ost pr update 42 --title "feat(cart): add coupon codes"',
    "ost pr update 42 --body-file .scratch/pr.md --ready",
  ],
  async run(env, input, ctx) {
    if (input.draft && input.ready) {
      throw new PortError("invalid", "Pass either draft or ready, not both.");
    }

    const text = textOf(env, ctx, input, false);
    const draft = input.draft ? true : input.ready ? false : undefined;
    if (
      input.title === undefined &&
      text === undefined &&
      input.base === undefined &&
      draft === undefined
    ) {
      throw new PortError("invalid", "Nothing to update: pass title, body, base, draft or ready.");
    }

    const vcs = requireVcs(env);
    const ref = await repoOrWorktree(env, ctx, input.repo);
    const pr = await vcs.updatePullRequest(ref, input.number, {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(text === undefined ? {} : { body: text }),
      ...(input.base === undefined ? {} : { base: input.base }),
      ...(draft === undefined ? {} : { draft }),
    });

    const url = vcs.links.pr(ref, input.number);
    return result(
      [
        `Updated ${repoLabel(ref)}#${pr.number}${pr.draft ? " (draft)" : ""}: ${pr.title}`,
        `${pr.head.ref} -> ${pr.base.ref}`,
        url,
      ],
      { pr },
      [url],
    );
  },
});

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
    const verdicts: ReviewVerdict[] = [
      ...(input.approve ? (["approve"] as const) : []),
      ...(input.requestChanges ? (["request_changes"] as const) : []),
      ...(input.comment ? (["comment"] as const) : []),
    ];

    if (verdicts.length !== 1) {
      throw new PortError("invalid", "Pass exactly one of approve, request-changes or comment.");
    }

    const comments = commentsOf(env, ctx, input.commentFile);
    const text = textOf(env, ctx, input, false) ?? "";
    if (verdicts[0] !== "approve" && !text.trim() && !comments?.length) {
      throw new PortError("invalid", "A review that is not an approval needs a body or comments.");
    }

    const vcs = requireVcs(env);
    const ref = await repoOrWorktree(env, ctx, input.repo);
    await vcs.submitReview(ref, input.number, {
      verdict: verdicts[0]!,
      body: text,
      ...(comments?.length ? { comments } : {}),
    });

    const url = vcs.links.pr(ref, input.number);
    const label = verdicts[0]!.replace("_", " ");
    return result(
      [
        `Submitted a review (${label}${comments?.length ? `, ${comments.length} inline` : ""}) on ${repoLabel(ref)}#${input.number}.`,
        url,
      ],
      { verdict: verdicts[0], comments: comments?.length ?? 0 },
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
    await vcs.commentOnPullRequest(ref, input.number, text);
    const url = vcs.links.pr(ref, input.number);
    return result([`Commented on ${repoLabel(ref)}#${input.number}.`, url], {}, [url]);
  },
});

export const prDiff = defineVerb({
  name: "pr.diff",
  summary: "Show the unified diff of a pull request.",
  description:
    "Prints the unified diff of a pull request after its link. Needs only read access; use it instead of gh pr diff.",
  input: z.strictObject({ repo, number }),
  args: ["number"],
  examples: ["ost pr diff 42"],
  async run(env, input, ctx) {
    const vcs = requireVcs(env);
    const ref = await repoOrWorktree(env, ctx, input.repo);
    const diff = await vcs.diff(ref, input.number);
    const url = vcs.links.pr(ref, input.number);
    return result(
      [`${repoLabel(ref)}#${input.number}`, url, "", diff.trimEnd() || "(empty diff)"],
      { diff },
      [url],
    );
  },
});

export const prWriteVerbs = [prOpen, prUpdate, prReview, prReply, prComment, prDiff];
