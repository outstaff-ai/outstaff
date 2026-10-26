import type { RunRequest } from "@outstaff/core";
import type { Link } from "@outstaff/protocol";
import type { Offer } from "../office-client/index.js";
import { VERBS, createRuntimeTools } from "../verbs/index.js";
import type { ChatReportKind } from "../verbs/office.types.js";
import { anyBlocked } from "./blocked.js";
import { JOURNAL_PROMPT, journalEntry } from "./journal.js";
import { buildWorkPrompt } from "./prompt.js";
import type { WorkerContext } from "./loop.types.js";
import { itemEnv, itemFiles } from "./item-env.js";
import { linksIn } from "./links.js";
import { reason } from "./reason.js";

export const CHAT_KIND = "chat";
const PROGRESS_MAX = 300;

const progressLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > PROGRESS_MAX ? `${line.slice(0, PROGRESS_MAX - 1)}…` : line;
};

/** Runs one accepted item to its hand-back. */
export function createWorker({ opts, log, sessions }: WorkerContext) {
  const now = opts.now ?? Date.now;
  const progressEveryMs = opts.progressEveryMs ?? 30_000;

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

  async function work(offer: Offer, abort: AbortController) {
    const id = offer.workItem.id;
    const sessionId = sessions.resumeFor(offer);

    // A chat session reads and answers; it has no worktree and runs under the chat policy.
    const session = offer.workItem.kind === CHAT_KIND ? opts.chatSession : undefined;
    const policy = session?.policy ?? opts.policy;
    const verbs = policy.ost ? VERBS.filter((v) => policy.ost!.allow.includes(v.name)) : VERBS;
    const workspace = session ? undefined : await opts.workspaces?.prepare(offer);

    // A resumed session already knows the conversation; the thread's later messages are in the journal.
    const chatContext =
      offer.workItem.origin && !sessionId ? await opts.chat?.context(offer) : undefined;

    const { attachments, ticketFiles } = await itemFiles(opts, offer, log);
    const { env, moved, asked, filedWork } = itemEnv(
      opts,
      offer,
      { attachments, ticketFiles },
      log,
    );

    const baseTracker = opts.env.tracker;

    const requestFor = (prompt: string, resume: string | undefined): RunRequest => ({
      ...(resume ? { sessionId: resume } : {}),
      workItemId: id,
      prompt,
      systemPrompt: opts.systemPrompt,
      workdir: opts.workdir,
      addDirs: workspace ? [...opts.addDirs, workspace.worktree, workspace.scratch] : opts.addDirs,
      policy,
      tools: createRuntimeTools(env, verbs, workspace ? { cwd: workspace.worktree } : {}),
      builtinTools: session?.builtinTools ?? opts.builtinTools,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      signal: abort.signal,
    });

    let lastProgress = Number.NEGATIVE_INFINITY;
    let lastText = "";
    let current = sessionId;
    type Outcome = {
      ok: boolean;
      text: string;
      error?: string | undefined;
      interrupted?: boolean | undefined;
      sessionLost?: boolean | undefined;
    };

    async function round(request: RunRequest): Promise<Outcome | undefined> {
      let outcome: Outcome | undefined;
      try {
        for await (const e of opts.runtime.run(request)) {
          if (e.type === "started") {
            current = e.sessionId;
            await sessions.started(id, e.sessionId);
          } else if (e.type === "text") {
            lastText = e.text;
            const t = now();
            const line = progressLine(e.text);
            if (line && t - lastProgress >= progressEveryMs) {
              lastProgress = t;
              opts.office.progress(id, line).catch((err) => {
                log.warn("could not send progress", { workItemId: id, error: reason(err) });
              });
            }
          } else if (e.type === "usage") {
            opts.usage?.observe(e);
          } else if (e.type === "finished") {
            outcome = e;
          }
        }
      } catch (e) {
        outcome = { ok: false, text: lastText, error: reason(e) };
      }

      return outcome;
    }

    const prompt = (restarted: boolean, context: string | undefined) =>
      buildWorkPrompt(offer, {
        resumed: sessionId !== undefined && !restarted,
        restarted,
        ...(opts.env.layout ? { docsDir: opts.env.layout.workDir } : {}),
        ...(offer.interrupted ? { interrupted: true } : {}),
        ...(workspace ? { workspace } : {}),
        ...(opts.repos?.length ? { repos: opts.repos } : {}),
        ...(context ? { chatContext: context } : {}),
        attachments,
        ticketFiles,
      });

    let outcome = await round(requestFor(prompt(false, chatContext), sessionId));

    // A stored session the runtime no longer knows is replaced by a new one that starts from the journal and the
    // state in the offer. It never starts from nothing, and the journal says so.
    if (sessionId && outcome?.sessionLost && !abort.signal.aborted) {
      log.warn("the stored session is lost; starting a new one from the journal", {
        workItemId: id,
      });

      await appendJournal(
        id,
        "Session restarted from journal: the stored session could not be resumed.",
      );

      lastText = "";
      current = undefined;
      // The new session knows nothing of the conversation, so it gets it like any new chat session.
      const restartContext = offer.workItem.origin ? await opts.chat?.context(offer) : undefined;
      outcome = await round(requestFor(prompt(true, restartContext), undefined));
    }

    /** The entry for this hand-back: asked of the runtime in the same session, else taken from the final message. */
    async function entryFor(text: string, links: Link[], ask: boolean) {
      let answer: string | undefined;
      if (ask && current) {
        try {
          for await (const e of opts.runtime.run({
            ...requestFor(JOURNAL_PROMPT, current),
            tools: [],
            builtinTools: [],
            maxTurns: 1,
          })) {
            if (e.type === "finished" && e.ok) {
              answer = e.text;
            }
          }
        } catch (e) {
          log.warn("could not ask for a journal entry", { workItemId: id, error: reason(e) });
        }
      }

      return journalEntry(answer, text, links);
    }

    if (abort.signal.aborted || outcome?.interrupted) {
      const text = outcome?.text || lastText;
      await appendJournal(id, await entryFor(text, linksIn(text), false));
      await opts.office.handBack(id, {
        summary: `Stopped before finishing because the agent shut down. ${text ? `Last message: ${text}` : "Nothing to report yet."}`,
        links: linksIn(text),
        status: "interrupted",
      });

      return;
    }

    if (!outcome) {
      await opts.office.fail(id, "The runtime ended without a result.");
      await report(offer, "failed", "The runtime ended without a result.");
      return;
    }

    if (!outcome.ok) {
      const why = outcome.error ?? "The run failed.";
      await opts.office.fail(id, why);
      await report(offer, "failed", why);
      return;
    }

    const text = outcome.text || lastText;
    const offeredTickets = new Set(
      offer.context.subjects.filter((x) => x.type === "ticket").map((x) => x.ref),
    );

    const last = [...moved]
      .filter(([k]) => offeredTickets.size === 0 || offeredTickets.has(k))
      .at(-1);

    // A ticket that is blocked in the tracker at the end of a run that moved nothing and asked nothing was not got past:
    // a blocked hand-back, whatever the final message says.
    const stillBlocked =
      !asked() &&
      last?.[1] === undefined &&
      (await anyBlocked(
        baseTracker,
        [...offeredTickets].filter((k) => !moved.has(k)),
      ));

    const blocked = last?.[1] === "blocked" || stillBlocked;

    if (blocked && !asked()) {
      log.warn(
        stillBlocked
          ? "the agent left its blocked ticket blocked; handing back as blocked"
          : "the agent left its ticket blocked; handing back as blocked",
        { workItemId: id },
      );
    }

    const status = asked() ? "waiting" : blocked ? "blocked" : "done";
    await appendJournal(id, await entryFor(text, linksIn(text), true));
    await opts.office.handBack(id, {
      summary: text || "Finished without a message.",
      links: linksIn(text),
      status,
    });

    // An item that waits (for a teammate's answer) tells the requester nothing yet; it reports when it is done.
    if (status === "done" && !filedWork()) {
      await report(offer, "result", text || "Done.", linksIn(text));
    }

    // The office says whether the agent tells the requester about a blocked item (when the team has no PM to route it
    // to, or the switch says so); the runner posts it, so it does not depend on the model.
    if (status === "blocked" && !filedWork()) {
      await report(offer, "blocked", text || "Blocked.", linksIn(text));
    }

    // Waiting and blocked items keep their worktree for the next round.
    if (status === "done") {
      await opts.workspaces?.release(id).catch((err) => {
        log.warn("could not clean up after an item", { workItemId: id, error: reason(err) });
      });
    }
  }

  return work;
}
