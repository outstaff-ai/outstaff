import type { Link } from "@outstaff/protocol";
import type { Offer } from "#/office-client/index.js";
import type { ChatReportKind } from "#/verbs/office.types.js";
import { JOURNAL_PROMPT, journalEntry } from "./journal.js";
import type { WorkerContext } from "./loop.types.js";
import { linksIn } from "./links.js";
import { reason } from "./reason.js";
import { createRounds } from "./work-round.js";
import { setUpItem } from "./work-setup.js";
import { handBackStatus } from "./work-status.js";
import type { HandBackStatus, ItemRun, Outcome } from "./work.types.js";

export { CHAT_KIND } from "./work-setup.js";

/** What the requester is told about a finished item, by status; waiting items report once they are done. */
const REPORTS: Partial<Record<HandBackStatus, { kind: "result" | "blocked"; fallback: string }>> = {
  done: { kind: "result", fallback: "Done." },
  // The office says whether the agent tells the requester about a blocked item (when the team has no PM to route it
  // to, or the switch says so); the runner posts it, so it does not depend on the model.
  blocked: { kind: "blocked", fallback: "Blocked." },
};

/** The agent shut down while the item ran. */
const wasInterrupted = (run: ItemRun, outcome: Outcome | undefined) =>
  run.abort.signal.aborted || Boolean(outcome?.interrupted);

/** Why a run that did not succeed failed. */
const failureReason = (outcome: Outcome | undefined) =>
  outcome ? (outcome.error ?? "The run failed.") : "The runtime ended without a result.";

/** Runs one accepted item to its hand-back. */
export function createWorker(ctx: WorkerContext) {
  const { opts, log } = ctx;

  /** A journal entry that cannot be stored is logged; it must not keep the hand-back from the office. */
  async function appendJournal(id: string, text: string) {
    try {
      await opts.office.journal(id, text);
    } catch (e) {
      log.warn("could not store a journal entry", { workItemId: id, error: reason(e) });
    }
  }

  async function report(
    offer: Offer,
    kind: Exclude<ChatReportKind, "ack">,
    text: string,
    links: Link[] = [],
  ) {
    // Without an origin in the offer the office still knows of threads attached to the item since.
    if (!opts.chat) {
      return;
    }

    try {
      await opts.chat.report(offer, kind, text, links);
    } catch (e) {
      log.warn("could not tell the requester", { workItemId: offer.workItem.id, error: reason(e) });
    }
  }

  /** The runtime's answer to the journal prompt, asked in the item's session. */
  async function askJournal(run: ItemRun, session: string): Promise<string | undefined> {
    let answer: string | undefined;
    try {
      const request = { ...run.request(JOURNAL_PROMPT, session), tools: [], builtinTools: [] };
      for await (const e of opts.runtime.run({ ...request, maxTurns: 1 })) {
        if (e.type === "finished" && e.ok) {
          answer = e.text;
        }
      }
    } catch (e) {
      log.warn("could not ask for a journal entry", {
        workItemId: run.offer.workItem.id,
        error: reason(e),
      });
    }

    return answer;
  }

  /** The entry for this hand-back: asked of the runtime in the same session, else taken from the final message. */
  async function entryFor(run: ItemRun, text: string, ask: boolean) {
    const answer = ask && run.current ? await askJournal(run, run.current) : undefined;

    return journalEntry(answer, text, linksIn(text));
  }

  /**
   * A stored session the runtime no longer knows is replaced by a new one that starts from the journal and the state
   * in the offer. It never starts from nothing, and the journal says so.
   */
  async function restartSession(run: ItemRun, round: ReturnType<typeof createRounds>) {
    const id = run.offer.workItem.id;
    log.warn("the stored session is lost; starting a new one from the journal", { workItemId: id });
    await appendJournal(
      id,
      "Session restarted from journal: the stored session could not be resumed.",
    );

    run.lastText = "";
    run.current = undefined;
    // The new session knows nothing of the conversation, so it gets it like any new chat session.
    const context = run.offer.workItem.origin ? await opts.chat?.context(run.offer) : undefined;

    return round(run.request(run.prompt(true, context), undefined));
  }

  async function runRounds(run: ItemRun): Promise<Outcome | undefined> {
    const round = createRounds(ctx, run);
    const outcome = await round(run.request(run.prompt(false, run.chatContext), run.storedSession));
    const lost = run.storedSession && outcome?.sessionLost && !run.abort.signal.aborted;

    return lost ? restartSession(run, round) : outcome;
  }

  async function handBackInterrupted(run: ItemRun, text: string) {
    const id = run.offer.workItem.id;
    await appendJournal(id, await entryFor(run, text, false));
    await opts.office.handBack(id, {
      summary: `Stopped before finishing because the agent shut down. ${text ? `Last message: ${text}` : "Nothing to report yet."}`,
      links: linksIn(text),
      status: "interrupted",
    });
  }

  async function failed(offer: Offer, why: string) {
    await opts.office.fail(offer.workItem.id, why);
    await report(offer, "failed", why);
  }

  async function handBackFinished(run: ItemRun, text: string) {
    const { offer, item } = run;
    const id = offer.workItem.id;
    const status = await handBackStatus(ctx, run);
    await appendJournal(id, await entryFor(run, text, true));
    await opts.office.handBack(id, {
      summary: text || "Finished without a message.",
      links: linksIn(text),
      status,
    });

    const tell = REPORTS[status];
    if (tell && !item.filedWork()) {
      await report(offer, tell.kind, text || tell.fallback, linksIn(text));
    }

    // Waiting and blocked items keep their worktree for the next round.
    if (status === "done") {
      await opts.workspaces?.release(id).catch((err) => {
        log.warn("could not clean up after an item", { workItemId: id, error: reason(err) });
      });
    }
  }

  return async function work(offer: Offer, abort: AbortController) {
    const run = await setUpItem(ctx, offer, abort);
    const outcome = await runRounds(run);
    if (wasInterrupted(run, outcome)) {
      await handBackInterrupted(run, outcome?.text || run.lastText);
      return;
    }

    if (!outcome?.ok) {
      await failed(offer, failureReason(outcome));
      return;
    }

    await handBackFinished(run, outcome.text || run.lastText);
  };
}
