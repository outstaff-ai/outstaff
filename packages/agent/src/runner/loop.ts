import {
  silentLogger,
  type Logger,
  type Policy,
  type RunRequest,
  type Runtime,
  type ToolKind,
} from "@outstaff/core";
import type { Link } from "@outstaff/protocol";
import type { Offer, OfficeConnection } from "../office-client/index.js";
import type { Workspaces } from "../repos/index.js";
import { VERBS, createRuntimeTools } from "../verbs/index.js";
import type { ChatReportKind } from "../verbs/office.js";
import type { AgentEnv } from "../verbs/types.js";
import { JOURNAL_PROMPT, journalEntry } from "./journal.js";
import type { ChatRelay } from "./chat.js";
import { buildWorkPrompt } from "./prompt.js";
import type { UsageReporter } from "./usage.js";
import { createSessionManager, type SessionManager } from "./sessions.js";

/** What the loop uses of the office connection. Heartbeats are sent by the connection itself while an item is accepted. */
export type WorkConnection = Pick<
  OfficeConnection,
  | "offers"
  | "accept"
  | "decline"
  | "progress"
  | "handBack"
  | "fail"
  | "session"
  | "journal"
  | "resume"
>;

export interface WorkLoopOptions {
  office: WorkConnection;
  runtime: Runtime;

  /** The ports and identity the verbs use. Its `office` is wrapped to see whether the agent asked something. */
  env: AgentEnv;
  systemPrompt: string;
  policy: Policy;
  builtinTools: ToolKind[];
  workdir: string;
  addDirs: string[];

  /** Per-item worktree and scratch directory. Without it items run in `workdir` alone. */
  workspaces?: Workspaces;
  model?: string;
  maxTurns?: number;
  sessions?: SessionManager;

  /** Gets the usage events of the runtime and learns when the agent is busy. */
  usage?: Pick<UsageReporter, "observe" | "flush" | "setBusy">;

  /** Chat requests: the context a new chat session starts with, and the report to the requester. */
  chat?: Pick<ChatRelay, "context" | "report" | "acknowledge">;
  log?: Logger;

  /** Least time between two progress messages for an item. Default 30000. */
  progressEveryMs?: number;
  now?: () => number;
}

export interface WorkLoop {
  /** Takes offers one at a time until the connection ends or `stop` is called. */
  run(): Promise<void>;

  /** Interrupts the running item, hands it back as waiting, and ends `run`. */
  stop(): Promise<void>;
}

const URL_PATTERN = /https?:\/\/[^\s<>()"'`\]]+/g;
const PROGRESS_MAX = 300;

/** Links in the final message, in order, without trailing punctuation or repeats. */
export function linksIn(text: string): Link[] {
  const urls = (text.match(URL_PATTERN) ?? []).map((u) => u.replace(/[.,;:!?*_]+$/, ""));
  return [...new Set(urls)].map((url) => ({ url }));
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

const progressLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > PROGRESS_MAX ? `${line.slice(0, PROGRESS_MAX - 1)}…` : line;
};

export function createWorkLoop(opts: WorkLoopOptions): WorkLoop {
  const log = opts.log ?? silentLogger;
  const now = opts.now ?? Date.now;
  const progressEveryMs = opts.progressEveryMs ?? 30_000;
  const sessions = opts.sessions ?? createSessionManager(opts.office, log);
  let stopping = false;
  let active: AbortController | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  /** Items the office still lists as ours after a restart have no offer to resume from; it queues them again. */
  async function releaseResumed() {
    for (const id of opts.office.resume()) {
      try {
        await opts.office.decline(id, "The agent restarted while working on this item.");
      } catch (e) {
        log.warn("could not release an item left over from before a restart", {
          workItemId: id,
          error: reason(e),
        });
      }
    }
  }

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
    if (!offer.workItem.origin || !opts.chat) {
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
    const workspace = await opts.workspaces?.prepare(offer);

    // A resumed session already knows the conversation; the thread's later messages are in the journal.
    const chatContext =
      offer.workItem.origin && !sessionId ? await opts.chat?.context(offer) : undefined;

    // The ask verb reports a question that is still open; the item then waits for the answer instead of being done.
    let asked = false;
    const base = opts.env.office;
    const env: AgentEnv = base
      ? {
          ...opts.env,
          office: {
            ...base,
            async ask(q) {
              const r = await base.ask(q);
              asked ||= r.status === "pending";
              return r;
            },
            async linkTicket(workItemId, ticket) {
              const r = await base.linkTicket(workItemId, ticket);
              // The first reply in the thread tells the requester what tracks the request.
              if (workItemId === id && offer.workItem.origin) {
                await opts.chat?.acknowledge(offer, { key: ticket, ...r }).catch((err) => {
                  log.warn("could not acknowledge in chat", { workItemId: id, error: reason(err) });
                });
              }

              return r;
            },
          },
        }
      : opts.env;

    const requestFor = (prompt: string, resume: string | undefined): RunRequest => ({
      ...(resume ? { sessionId: resume } : {}),
      workItemId: id,
      prompt,
      systemPrompt: opts.systemPrompt,
      workdir: opts.workdir,
      addDirs: workspace ? [...opts.addDirs, workspace.worktree, workspace.scratch] : opts.addDirs,
      policy: opts.policy,
      tools: createRuntimeTools(env, VERBS, workspace ? { cwd: workspace.worktree } : {}),
      builtinTools: opts.builtinTools,
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
        ...(workspace ? { workspace } : {}),
        ...(context ? { chatContext: context } : {}),
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
        status: "waiting",
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
    const status = asked ? "waiting" : "done";
    await appendJournal(id, await entryFor(text, linksIn(text), true));
    await opts.office.handBack(id, {
      summary: text || "Finished without a message.",
      links: linksIn(text),
      status,
    });

    // An item that waits (for a teammate's answer) tells the requester nothing yet; it reports when it is done.
    if (status === "done") {
      await report(offer, "result", text || "Done.", linksIn(text));
    }

    // Waiting and blocked items keep their worktree for the next round.
    if (status === "done") {
      await opts.workspaces?.release(id).catch((err) => {
        log.warn("could not clean up after an item", { workItemId: id, error: reason(err) });
      });
    }
  }

  async function handle(offer: Offer) {
    const id = offer.workItem.id;
    const abort = new AbortController();
    active = abort;
    try {
      await opts.office.accept(id);
    } catch (e) {
      log.warn("could not accept an offer", { workItemId: id, error: reason(e) });
      return;
    }

    if (stopping) {
      abort.abort();
    }

    opts.usage?.setBusy(true);
    try {
      await work(offer, abort);
    } catch (e) {
      log.error("work item failed", { workItemId: id, error: reason(e) });
      await opts.office.fail(id, reason(e)).catch(() => {});
    } finally {
      active = undefined;
      opts.usage?.setBusy(false);
      opts.usage?.flush();
    }
  }

  return {
    async run() {
      await releaseResumed();
      for await (const offer of opts.office.offers()) {
        if (stopping) {
          // Not accepted, so the office offers it again later.
          break;
        }

        inFlight = handle(offer);
        await inFlight;
        if (stopping) {
          break;
        }
      }
    },

    async stop() {
      stopping = true;
      active?.abort();
      await inFlight;
    },
  };
}
