import {
  policyOn,
  silentLogger,
  type Logger,
  type Policy,
  type RunRequest,
  type Runtime,
  type TeamConfig,
  type ToolKind,
} from "@outstaff/core";
import type { Filed, Link } from "@outstaff/protocol";
import type { FiledWhat } from "./chat.js";
import type { Offer, OfficeConnection } from "../office-client/index.js";
import type { ClonedRepo, Workspaces } from "../repos/index.js";
import { VERBS, createRuntimeTools } from "../verbs/index.js";
import type { ChatReportKind } from "../verbs/office.js";
import type { AgentEnv } from "../verbs/types.js";
import { anyBlocked, saysBlocked } from "./blocked.js";
import { JOURNAL_PROMPT, journalEntry } from "./journal.js";
import type { ChatRelay } from "./chat.js";
import type { ProfilePublisher } from "./profile.js";
import { buildWorkPrompt } from "./prompt.js";
import { saveTicketFiles, type Attachment } from "./attachments.js";
import { safeId } from "../repos/workspaces.js";
import { join } from "node:path";
import { acknowledgeFeedback } from "./reactions.js";
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

  /**
   * How chat sessions run: beside the active item, with their own policy (see the `chat` permission profile) and
   * no worktree. Without it a chat item runs like any other item.
   */
  chatSession?: { policy: Policy; builtinTools: ToolKind[] };

  /** Per-item worktree and scratch directory. Without it items run in `workdir` alone. */
  workspaces?: Workspaces;

  /** The repositories the person has a grant on, listed in the work prompt with their access. */
  repos?: ClonedRepo[];
  model?: string;
  maxTurns?: number;
  sessions?: SessionManager;

  /** Gets the usage events of the runtime and learns when the agent is busy. */
  usage?: Pick<UsageReporter, "observe" | "flush" | "setBusy">;

  /** Chat requests: the context a new chat session starts with, and the report to the requester. */
  chat?: Pick<ChatRelay, "context" | "report" | "acknowledge" | "attachments">;
  log?: Logger;

  /** Told when the work or the agent's status changes, so the chat profile follows. */
  profile?: Pick<ProfilePublisher, "changed">;

  /** The team's `policies`; `acknowledge.vcs` decides whether feedback gets a reaction. */
  policies?: TeamConfig["policies"];

  /** Least time between two progress messages for an item. Default 30000. */
  progressEveryMs?: number;
  now?: () => number;
}

export interface WorkLoop {
  /**
   * Takes work items one at a time, and chat sessions beside them, until the connection ends or `stop` is called.
   * The office decides how many chat sessions it offers.
   */
  run(): Promise<void>;

  /** Interrupts the running item, hands it back as interrupted, and ends `run`. */
  stop(): Promise<void>;
}

const CHAT_KIND = "chat";
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
  const running = new Map<string, AbortController>();
  const inFlight = new Set<Promise<void>>();
  let workLane: Promise<void> = Promise.resolve();

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

    // Files people shared with the request or attached to its tickets: data, downloaded into the item's scratch
    // directory (deleted with it) so the model can read them.
    const scratch = opts.env.layout ? join(opts.env.layout.scratchDir, safeId(id)) : undefined;
    const attachments: Attachment[] =
      scratch && offer.workItem.origin?.files?.length && opts.chat
        ? await opts.chat.attachments(offer, join(scratch, "files")).catch((err) => {
            log.warn("could not read the files of a chat message", {
              workItemId: id,
              error: reason(err),
            });

            return [];
          })
        : [];

    const ticketKeys = offer.context.subjects.filter((s) => s.type === "ticket").map((s) => s.ref);
    const ticketFiles =
      scratch && ticketKeys.length
        ? await saveTicketFiles(opts.env.tracker, ticketKeys, join(scratch, "tickets"), log)
        : {};

    // A chat session that filed its request as work tells the requester in the thread. The work reports its own result.
    let filedWork = false;
    const filed = async (workItemId: string, what: FiledWhat, f: Filed) => {
      if (workItemId !== id || !offer.workItem.origin) {
        return;
      }

      filedWork = true;
      await opts.chat?.acknowledge(offer, what, f).catch((err) => {
        log.warn("could not acknowledge in chat", { workItemId: id, error: reason(err) });
      });
    };

    // The ask verb reports a question that is still open; the item then waits for the answer instead of being done.
    let asked = false;
    // The last status the agent moved each ticket to in this run; a ticket it left blocked is handed back as blocked.
    const moved = new Map<string, string>();
    const baseTracker = opts.env.tracker;
    const tracker = baseTracker
      ? Object.create(baseTracker, {
          transition: {
            value: async (...args: Parameters<typeof baseTracker.transition>) => {
              const issue = await baseTracker.transition(...args);
              moved.delete(args[0]);
              moved.set(args[0], args[1]);
              return issue;
            },
          },
        })
      : undefined;

    const base = opts.env.office;
    const files = {
      ...(attachments.length ? { attachments } : {}),
      ...(Object.keys(ticketFiles).length ? { ticketFiles } : {}),
    };

    const env: AgentEnv = base
      ? {
          ...opts.env,
          ...files,
          ...(tracker ? { tracker } : {}),
          office: {
            ...base,
            async ask(q) {
              const r = await base.ask(q);
              asked ||= r.status === "pending";
              return r;
            },
            async linkTicket(workItemId, ticket) {
              const r = await base.linkTicket(workItemId, ticket);
              await filed(workItemId, { key: ticket, title: ticket }, r);
              return r;
            },
            async attachWork(workItemId, request) {
              const r = await base.attachWork(workItemId, request);
              await filed(workItemId, { attached: r.attached, title: r.item.title }, r);
              return r;
            },
            async queueWork(workItemId, request) {
              const r = await base.queueWork(workItemId, request);
              await filed(workItemId, { title: request.title }, r);
              return r;
            },
          },
        }
      : tracker
        ? { ...opts.env, ...files, tracker }
        : { ...opts.env, ...files };

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

    // A retry of a blocked ticket that ends "still blocked" in free text moved nothing: the ticket is still blocked,
    // and the message says so. That is a blocked hand-back, not a finished one.
    const stillBlocked =
      !asked &&
      last?.[1] === undefined &&
      saysBlocked(text) &&
      (await anyBlocked(
        baseTracker,
        [...offeredTickets].filter((k) => !moved.has(k)),
      ));

    const blocked = last?.[1] === "blocked" || stillBlocked;

    if (blocked && !asked) {
      log.warn(
        stillBlocked
          ? "the agent says its blocked ticket is still blocked; handing back as blocked"
          : "the agent left its ticket blocked; handing back as blocked",
        { workItemId: id },
      );
    }

    const status = asked ? "waiting" : blocked ? "blocked" : "done";
    await appendJournal(id, await entryFor(text, linksIn(text), true));
    await opts.office.handBack(id, {
      summary: text || "Finished without a message.",
      links: linksIn(text),
      status,
    });

    // An item that waits (for a teammate's answer) tells the requester nothing yet; it reports when it is done.
    if (status === "done" && !filedWork) {
      await report(offer, "result", text || "Done.", linksIn(text));
    }

    // The office says whether the agent tells the requester about a blocked item (when the team has no PM to route it
    // to, or the switch says so); the runner posts it, so it does not depend on the model.
    if (status === "blocked" && !filedWork) {
      await report(offer, "blocked", text || "Blocked.", linksIn(text));
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
    running.set(id, abort);
    try {
      await opts.office.accept(id);
    } catch (e) {
      log.warn("could not accept an offer", { workItemId: id, error: reason(e) });
      running.delete(id);
      return;
    }

    if (stopping) {
      abort.abort();
    }

    opts.profile?.changed();
    opts.usage?.setBusy(true);
    try {
      // Before the run starts, so the people who wrote the feedback see at once that it was taken.
      if (policyOn(opts.policies, "acknowledge.vcs")) {
        await acknowledgeFeedback(offer, opts.env.vcs, log);
      }

      await work(offer, abort);
    } catch (e) {
      log.error("work item failed", { workItemId: id, error: reason(e) });
      await opts.office.fail(id, reason(e)).catch(() => {});
    } finally {
      running.delete(id);
      opts.usage?.setBusy(running.size > 0);
      opts.usage?.flush();
      // Handed back or failed: the status is idle now, or the next item.
      opts.profile?.changed();
    }
  }

  const track = (p: Promise<void>) => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  return {
    async run() {
      await releaseResumed();
      for await (const offer of opts.office.offers()) {
        if (stopping) {
          // Not accepted, so the office offers it again later.
          break;
        }

        opts.profile?.changed();
        if (offer.workItem.kind === CHAT_KIND && opts.chatSession) {
          track(handle(offer));
        } else {
          // One work item at a time, in the order they came.
          workLane = workLane.then(() => (stopping ? undefined : handle(offer)));
          track(workLane);
        }
      }

      await Promise.all(inFlight);
    },

    async stop() {
      stopping = true;
      for (const abort of running.values()) {
        abort.abort();
      }

      await Promise.all(inFlight);
    },
  };
}
