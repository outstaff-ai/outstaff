import {
  parseRepoUrl,
  type Logger,
  type ReactionTarget,
  type RepoRef,
  type Vcs,
} from "@outstaff/core";
import type { Offer } from "../office-client/index.js";

/** The kinds of work item that carry feedback from people on a pull request. */
const FEEDBACK_KINDS = new Set(["review_feedback", "merged_feedback"]);

/** `host/owner/name#number`, how the office keys a pull request. */
function repoOfPr(ref: string): RepoRef | undefined {
  const at = ref.lastIndexOf("#");
  if (at < 1) {
    return undefined;
  }

  try {
    return parseRepoUrl(ref.slice(0, at));
  } catch {
    return undefined;
  }
}

/** What each piece of feedback in the offer was written on, once each. A review body has nothing to react to. */
export function reactionTargets(offer: Offer): ReactionTarget[] {
  const found = new Map<string, ReactionTarget>();
  const add = (target: ReactionTarget) => found.set(`${target.kind}:${target.id}`, target);
  for (const fb of offer.context.feedback ?? []) {
    if (fb.kind === "review") {
      for (const c of fb.comments ?? []) {
        add({ kind: "inline_comment", id: c.id });
      }
    } else if (fb.commentId) {
      add({
        kind: fb.kind === "comment" ? "conversation_comment" : "inline_comment",
        id: fb.commentId,
      });
    }
  }

  return [...found.values()];
}

/** How long the run waits for the reactions, so a slow host delays a round by at most this. */
export const ACKNOWLEDGE_TIMEOUT_MS = 2000;

/**
 * Tells the people behind a round's feedback that the agent took it: an `eyes` reaction on each comment, as the
 * person the agent works as. The returned promise settles when every reaction has, or after
 * `ACKNOWLEDGE_TIMEOUT_MS`, whichever comes first, so the reactions land before the run's first reply without a
 * slow host holding the round. A reaction that fails is logged; it never stops the round.
 */
export async function acknowledgeFeedback(offer: Offer, vcs: Vcs | undefined, log: Logger) {
  if (!vcs || !FEEDBACK_KINDS.has(offer.workItem.kind)) {
    return;
  }

  const targets = reactionTargets(offer);
  if (targets.length === 0) {
    return;
  }

  const subjects = [offer.workItem.subject, ...offer.context.subjects].filter(
    (s) => s?.type === "pr",
  );

  const repo = subjects.map((s) => repoOfPr(s!.ref)).find((r) => r !== undefined);
  if (!repo) {
    log.warn("could not react to the feedback: the pull request's repository is unknown", {
      workItemId: offer.workItem.id,
    });

    return;
  }

  const reacted = Promise.all(
    targets.map(async (target) => {
      try {
        await vcs.react(repo, target, "eyes");
      } catch (e) {
        log.warn("could not react to feedback", {
          workItemId: offer.workItem.id,
          target: `${target.kind} ${target.id}`,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn("the reactions to the feedback are slow; starting the run without waiting", {
        workItemId: offer.workItem.id,
      });

      resolve();
    }, ACKNOWLEDGE_TIMEOUT_MS);
  });

  try {
    await Promise.race([reacted, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
