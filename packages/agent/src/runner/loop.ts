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
import { createRuntimeTools } from "../verbs/index.js";
import type { AgentEnv } from "../verbs/types.js";
import { buildWorkPrompt } from "./prompt.js";
import { createSessionManager, type SessionManager } from "./sessions.js";

/** What the loop uses of the office connection. Heartbeats are sent by the connection itself while an item is accepted. */
export type WorkConnection = Pick<
  OfficeConnection,
  "offers" | "accept" | "decline" | "progress" | "handBack" | "fail" | "session" | "resume"
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
  model?: string;
  maxTurns?: number;
  sessions?: SessionManager;
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

  async function work(offer: Offer, abort: AbortController) {
    const id = offer.workItem.id;
    const sessionId = sessions.resumeFor(offer);

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
          },
        }
      : opts.env;

    const request: RunRequest = {
      ...(sessionId ? { sessionId } : {}),
      workItemId: id,
      prompt: buildWorkPrompt(offer, { resumed: sessionId !== undefined }),
      systemPrompt: opts.systemPrompt,
      workdir: opts.workdir,
      addDirs: opts.addDirs,
      policy: opts.policy,
      tools: createRuntimeTools(env),
      builtinTools: opts.builtinTools,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      signal: abort.signal,
    };

    let lastProgress = Number.NEGATIVE_INFINITY;
    let lastText = "";
    let outcome:
      | { ok: boolean; text: string; error?: string | undefined; interrupted?: boolean | undefined }
      | undefined;

    try {
      for await (const e of opts.runtime.run(request)) {
        if (e.type === "started") {
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
        } else if (e.type === "finished") {
          outcome = e;
        }
      }
    } catch (e) {
      outcome = { ok: false, text: lastText, error: reason(e) };
    }

    if (abort.signal.aborted || outcome?.interrupted) {
      const text = outcome?.text || lastText;
      await opts.office.handBack(id, {
        summary: `Stopped before finishing because the agent shut down. ${text ? `Last message: ${text}` : "Nothing to report yet."}`,
        links: linksIn(text),
        status: "waiting",
      });

      return;
    }

    if (!outcome) {
      await opts.office.fail(id, "The runtime ended without a result.");
      return;
    }

    if (!outcome.ok) {
      await opts.office.fail(id, outcome.error ?? "The run failed.");
      return;
    }

    const text = outcome.text || lastText;
    await opts.office.handBack(id, {
      summary: text || "Finished without a message.",
      links: linksIn(text),
      status: asked ? "waiting" : "done",
    });
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

    try {
      await work(offer, abort);
    } catch (e) {
      log.error("work item failed", { workItemId: id, error: reason(e) });
      await opts.office.fail(id, reason(e)).catch(() => {});
    } finally {
      active = undefined;
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
