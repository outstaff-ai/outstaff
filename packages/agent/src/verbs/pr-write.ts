import { PortError, policyValue } from "@outstaff/core";
import { z } from "zod";
import { repoLabel, requireVcs } from "./support.js";
import { autoMergeWhenReady } from "./auto-merge.js";
import { defineVerb, result } from "./define.js";
import type { AgentEnv } from "./types.js";
import { currentBranch, repoOrWorktree } from "./worktree.js";
import { body, bodyFile, number, repo, textOf } from "./pr-write-support.js";
import { prComment, prReply, prReview } from "./pr-review.js";
import { prDiff, prMerge } from "./pr-merge.js";

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
    `${ticket} already has ${existing.length === 1 ? "a pull request" : "pull requests"}: ${named}. One ticket takes one pull request, because outstaff moves the ticket to done when its pull request merges. Split the work: create a ticket for this part with \`ost ticket create --parent ${ticket} --assignee me --status active --title "..."\`, then open the pull request for that new ticket, with \`Closes <new ticket>\` in its body. To change the pull request ${ticket} already has, use \`ost pr update\` or push to its branch.`,
  );
}

export const prOpen = defineVerb({
  name: "pr.open",
  summary: "Open a pull request from a pushed branch.",
  description:
    "Opens a pull request as you. The head defaults to the branch checked out in your worktree, the base to the repository's default branch and the repository to the worktree's origin. Refuses to open from the default branch or a detached HEAD: create the branch first. Push the branch first. Pass draft to open it as a draft. A pull request opened ready gets the host's auto-merge (or the merge queue) when the team lets agents merge, as with pr update --ready. A ticket takes one pull request: it is refused when the ticket the pull request would link to (a closing keyword in the body, the branch, the title) already has one, open or merged; split the work into a sub-ticket with ticket create --parent and open the pull request for that ticket. A team can allow several with policies.tickets.prs_per_ticket: many.",
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
    const merging = await autoMergeWhenReady(env, vcs, ref, pr);
    return result(
      [
        `Opened ${repoLabel(ref)}#${pr.number}${pr.draft ? " (draft)" : ""}: ${pr.title}`,
        `${pr.head.ref} -> ${pr.base.ref}`,
        ...(merging ? [merging] : []),
        url,
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
    "Updates a pull request as you. Pass only what changes. draft turns it into a draft, ready marks a draft ready for review. When the team lets agents merge (policies.merge.on_approval), ready also turns on the host's auto-merge, or adds the pull request to the merge queue where the repository has one: the repository's required approvals and checks decide when it merges, and no further run of yours is needed. If that fails, the pull request is still ready; report why and do not merge it another way.",
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
    const merging = input.ready ? await autoMergeWhenReady(env, vcs, ref, pr) : undefined;
    return result(
      [
        `Updated ${repoLabel(ref)}#${pr.number}${pr.draft ? " (draft)" : ""}: ${pr.title}`,
        `${pr.head.ref} -> ${pr.base.ref}`,
        ...(merging ? [merging] : []),
        url,
      ],
      { pr },
      [url],
    );
  },
});

export const prWriteVerbs = [prOpen, prUpdate, prReview, prReply, prComment, prDiff, prMerge];
