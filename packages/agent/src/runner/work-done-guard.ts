import type { WorkerContext } from "./loop.types.js";
import { createRounds } from "./work-round.js";
import { handBackStatus } from "./work-status.js";
import { NOTHING_TO_REVIEW_PROMPT, finishesSilently, toReview } from "./work-review.js";
import type { HandBack, ItemRun, Outcome } from "./work.types.js";

/**
 * The status the run ends in now, and what it leaves to review when that is `done`. A `done` with nothing to review
 * is a silent finish for a kind that may finish silently, unless the agent said `done`. A `silent` the agent said
 * stays silent even beside a pull request open for review: it waits on that review, which the office checks.
 */
async function settle(ctx: WorkerContext, run: ItemRun): Promise<Omit<HandBack, "summary">> {
  const status = await handBackStatus(ctx, run);
  if (status === "done" && run.item.declared() === "silent") {
    return { status: "silent", toReview: [] };
  }

  const found = status === "done" ? toReview(run) : [];
  const silent = status === "done" && !found.length && finishesSilently(run);
  return { status: silent ? "silent" : status, toReview: found };
}

/** A `done` that leaves nothing to review. */
const refused = (h: Omit<HandBack, "summary">) => h.status === "done" && h.toReview.length === 0;

/** What the agent answered in the extra turn, else what it said before. */
const answerOf = (outcome: Outcome | undefined, run: ItemRun, text: string) =>
  (outcome?.ok && (outcome.text || run.lastText)) || text;

/** The extra turn that tells the agent there is nothing to review: its answer, or whether a shutdown cut it short. */
async function askAgain(ctx: WorkerContext, run: ItemRun, text: string) {
  const outcome = await createRounds(ctx, run)(run.request(NOTHING_TO_REVIEW_PROMPT, run.current));
  const interrupted = run.abort.signal.aborted || Boolean(outcome?.interrupted);
  return {
    summary: interrupted ? run.lastText || text : answerOf(outcome, run, text),
    interrupted,
  };
}

/**
 * A `done` hand-back needs a result to review or finished work (`toReview`), whatever the kind. When there is none,
 * and the round does not finish silently (`finishesSilently`), the agent is told so
 * once, in the same session, and the status is worked out again from that round. Still nothing: it is handed back as
 * `blocked`, with the agent's last message, which says what it needs.
 */
export async function guardedHandBack(
  ctx: WorkerContext,
  run: ItemRun,
  text: string,
): Promise<HandBack> {
  const first = await settle(ctx, run);
  if (!refused(first)) {
    return { ...first, summary: text };
  }

  const workItemId = run.offer.workItem.id;
  ctx.log.info("a done hand-back left nothing to review; telling the agent", { workItemId });
  const { summary, interrupted } = await askAgain(ctx, run, text);
  if (interrupted) {
    return { status: "blocked", summary, toReview: [], interrupted };
  }

  const again = await settle(ctx, run);
  if (!refused(again)) {
    return { ...again, summary };
  }

  ctx.log.warn("a done hand-back still left nothing to review; handing back as blocked", {
    workItemId,
  });

  return { status: "blocked", summary, toReview: [] };
}
