import { PortError } from "@outstaff/core";
import { z } from "zod";
import { repoLabel, requireHumanStarted, requireVcs } from "./support.js";
import { defineVerb, result } from "./define.js";
import { currentBranch, repoOrWorktree } from "./worktree.js";
import { body, bodyFile, number, repo, textOf } from "./pr-write-support.js";
import { prComment, prReply, prReview } from "./pr-review.js";
import { prDiff, prMerge } from "./pr-merge.js";
import { afterOpen, draftTicket, oneForTicket } from "./pr-open-ticket.js";
import { prAttach } from "./pr-attach.js";

export const prOpen = defineVerb({
  name: "pr.open",
  summary: "Open a pull request from a pushed branch.",
  description:
    "Opens a pull request as you. The head defaults to the branch checked out in your worktree, the base to the repository's default branch and the repository to the worktree's origin. Refuses to open from the default branch or a detached HEAD: create the branch first. Push the branch first. Pass draft to open it as a draft. Opening it ready does not set it to merge: when the team lets agents merge, you are woken to decide once it is approved. It is linked on the ticket it is for in the tracker right away, as you. A ticket takes one open pull request at a time: it is refused when the ticket the pull request would link to (a closing keyword in the body, the branch, the title) already has an open one, or is done or canceled. A merged one does not count while the ticket is open, so a follow-up fix after a merge (for example for a check that failed on the merge commit) goes on the same ticket. For a separate part, split the work into a sub-ticket with ticket create --parent and open the pull request for that ticket. A team can allow several with policies.tickets.prs_per_ticket: many. Only a trusted human starts new work: it is refused in a round another agent started (a teammate's question, an unblock, a mention by an agent); put the proposal to a trusted human on the ticket instead and hand back.",
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
    requireHumanStarted(env, "open a pull request");
    const ref = await repoOrWorktree(env, ctx, input.repo);
    const head = input.head ?? (await currentBranch(ctx));
    const text = textOf(env, ctx, input, true) ?? "";
    const found = await draftTicket(env, { headRef: head, title: input.title, body: text });
    oneForTicket(env, found);
    const pr = await vcs.openPullRequest(ref, {
      head,
      title: input.title,
      body: text,
      draft: input.draft,
      ...(input.base ? { base: input.base } : {}),
    });

    const url = vcs.links.pr(ref, pr.number);
    const linked = await afterOpen(env, ctx, { repo: ref, number: pr.number, url }, found?.ticket);
    return result(
      [
        `Opened ${repoLabel(ref)}#${pr.number}${pr.draft ? " (draft)" : ""}: ${pr.title}`,
        `${pr.head.ref} -> ${pr.base.ref}`,
        url,
        ...linked,
      ],
      { pr },
      [url],
    );
  },
});

/** The draft state `draft` or `ready` asks for, if either; both at once is refused. */
function draftChange(input: { draft?: boolean | undefined; ready?: boolean | undefined }) {
  if (input.draft && input.ready) {
    throw new PortError("invalid", "Pass either draft or ready, not both.");
  }

  if (input.draft) {
    return true;
  }

  return input.ready ? false : undefined;
}

/** The fields of `changes` that are set; the rest stay as they are. */
function definedOnly<T extends object>(changes: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

export const prUpdate = defineVerb({
  name: "pr.update",
  summary: "Change the title, body, base or draft state of a pull request.",
  description:
    "Updates a pull request as you. Pass only what changes. draft turns it into a draft, ready marks a draft ready for review. Marking it ready does not set it to merge: when the team lets agents merge (policies.merge.on_approval), you are woken to decide once it is approved and its checks pass.",
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
    const draft = draftChange(input);
    const text = textOf(env, ctx, input, false);
    const changes = definedOnly({ title: input.title, body: text, base: input.base, draft });
    if (Object.keys(changes).length === 0) {
      throw new PortError("invalid", "Nothing to update: pass title, body, base, draft or ready.");
    }

    const vcs = requireVcs(env);
    const ref = await repoOrWorktree(env, ctx, input.repo);
    const pr = await vcs.updatePullRequest(ref, input.number, changes);
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

export const prWriteVerbs = [
  prOpen,
  prUpdate,
  prAttach,
  prReview,
  prReply,
  prComment,
  prDiff,
  prMerge,
];
