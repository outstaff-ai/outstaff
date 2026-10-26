import { createTicketLinker, policyOn, silentLogger, type ChatMessage } from "@outstaff/core";
import {
  formatWorkGroups,
  groupWork,
  type Link,
  type WorkSummary,
  type ChatOrigin,
  MAX_CHAT_FILES,
} from "@outstaff/protocol";
import type { ChatMessageResult, ChatReportKind } from "../verbs/office.types.js";
import { saveAttachments } from "./attachments.js";
import type { ChatRelayOptions, ChatRelay } from "./chat.types.js";
import { chatContext } from "./chat-context.js";
import { placementQuestion, replyFor } from "./chat-replies.js";
import { clip, linkLine, splitReply, tag } from "./chat-text.js";
import { reason } from "./reason.js";

export function createChatRelay(opts: ChatRelayOptions): ChatRelay {
  const { chat, office, team } = opts;
  const log = opts.log ?? silentLogger;
  const historyLimit = opts.historyLimit ?? 10;
  const acknowledge = policyOn(team.policies, "acknowledge.chat");
  const hasPm = team.people.some((p) => p.role === "pm");

  const linker = createTicketLinker(team, opts.tracker);

  /** Ticket keys linked to the tracker by code, never by the model. */
  const linked = (text: string) => linker.format(text, "chat");
  const post = async (
    channel: string,
    thread: string | undefined,
    text: string,
    strict = false,
  ) => {
    try {
      await chat.post(channel, text, thread === undefined ? undefined : { thread });
    } catch (e) {
      log.warn("could not post to chat", { channel, error: reason(e) });
      if (strict) {
        throw e;
      }
    }
  };

  // Queued reports the office repeats until confirmed: one that was posted is never posted twice.
  const postedReports = new Set<string>();

  const ticketUrl = (key: string) => opts.tracker?.links.issue(key);

  /** The numbered list the requester picks a place from: one line per piece of work. */
  const describe = (work: WorkSummary[]) => formatWorkGroups(groupWork(work), ticketUrl);

  /** Whether the author started the thread or replied in it: the chat then notifies them without a mention. */
  async function takesPart(m: ChatMessage) {
    if (!m.thread) {
      return true;
    }

    try {
      const inThread = await chat.history(m.channel, { thread: m.thread, limit: historyLimit });
      return inThread.some((x) => x.author.id === m.author.id);
    } catch (e) {
      log.warn("could not read the thread to see who is in it", { error: reason(e) });
      return false;
    }
  }

  async function onMessage(m: ChatMessage) {
    // The adapter filters already; the relay never relies on that alone.
    if (!m.author.trusted || m.author.bot) {
      return;
    }

    const thread = m.thread ?? m.id;
    const participant = await takesPart(m);
    if (acknowledge) {
      chat.react(m.channel, m.id, "eyes").catch(() => {});
    }

    let result: ChatMessageResult;
    try {
      result = await office.chatMessage({
        messageId: m.id,
        channel: m.channel,
        ...(m.thread ? { thread: m.thread } : {}),
        text: m.text,
        author: { id: m.author.id, ...(m.author.name ? { name: m.author.name } : {}) },
        direct: m.direct ?? false,
        participant,
        ...(m.files?.length ? { files: m.files.slice(0, MAX_CHAT_FILES) } : {}),
      });
    } catch (e) {
      log.warn("the office did not take a chat message", { error: reason(e) });
      await post(
        m.channel,
        thread,
        "I could not reach the office just now. Please ask again in a moment.",
      );

      return;
    }

    if (result.repeated) {
      return;
    }

    const text = replyFor(result, hasPm, describe);
    if (text) {
      await post(m.channel, thread, linked(text));
    }
  }

  /** Posts a report in the threads it belongs to, or in a direct message with the requester. */
  async function deliver(
    kind: Exclude<ChatReportKind, "ack">,
    text: string,
    links: Link[],
    where: {
      direct?: string;
      threads: Pick<ChatOrigin, "channel" | "thread" | "direct" | "participant" | "requester">[];
    },
    strict = false,
  ) {
    const body =
      kind === "result"
        ? text.trim()
        : kind === "blocked"
          ? `I am blocked. ${text.trim()}`
          : `I hit an error and could not finish this. I will try again. ${clip(text, 1).slice(0, 300)}`;

    const all = links.filter(
      (l, i, a) => a.findIndex((x) => x.url === l.url) === i && !body.includes(l.url),
    );

    const parts = splitReply(body);
    const targets: { channel: string; thread?: string; mention: string }[] = [];
    for (const t of where.threads) {
      targets.push({ channel: t.channel, thread: t.thread, mention: tag(t) });
    }

    // A direct message is the requester's own: no thread, no mention.
    if (where.direct && targets.length === 0) {
      targets.push({ channel: await chat.openDirect(where.direct), mention: "" });
    }

    for (const t of targets) {
      for (const [i, part] of parts.entries()) {
        const last = i === parts.length - 1;
        await post(
          t.channel,
          t.thread,
          [linked(`${i === 0 ? t.mention : ""}${part}`), ...(last ? all.map(linkLine) : [])].join(
            "\n",
          ),
          strict,
        );
      }
    }
  }

  return {
    async start() {
      await chat.start(onMessage);
      await opts.profile?.start();
    },

    async stop() {
      opts.profile?.stop();
      await chat.stop();
    },

    async attachments(offer, dir) {
      const files = offer.workItem.origin?.files ?? [];
      if (!files.length) {
        return [];
      }

      return saveAttachments(files, {
        download: chat.download ? (f) => chat.download!(f) : undefined,
        dir,
        log,
      });
    },

    context: (offer) => chatContext({ chat, office, log, historyLimit, describe }, offer),

    async acknowledge(offer, what, filed) {
      const origin = offer.workItem.origin;
      if (!origin) {
        return;
      }

      const granted = await office.chatReport(offer.workItem.id, "ack");
      if (!granted.post) {
        return;
      }

      const url = what.key ? (filed.url ?? opts.tracker?.links.issue(what.key)) : undefined;
      const a = what.attached;
      const link = (r: { ref: string; url?: string | undefined }, text: string) =>
        r.url ? `[${text}](${r.url})` : text;

      const joined = a
        ? [
            a.pr ? link(a.pr, `PR ${a.pr.ref}`) : undefined,
            a.ticket
              ? link(
                  {
                    ref: a.ticket.ref,
                    url: a.ticket.url ?? opts.tracker?.links.issue(a.ticket.ref),
                  },
                  a.ticket.ref,
                )
              : undefined,
          ].filter(Boolean)
        : [];

      const tracked = a
        ? `Adding this to ${joined.join(" for ")}.${filed.item.status === "active" ? " I'll pick it up when the current round ends." : ""}`
        : what.key
          ? `Tracked in ${url ? `[${what.key}](${url})` : what.key}.`
          : `Queued: ${what.title}.`;

      await post(
        origin.channel,
        origin.thread,
        linked(
          [
            `${tag(origin)}${a ? tracked : `On it. ${tracked}`}`,
            ...(filed.waiting ? [placementQuestion(hasPm, describe, filed.work)] : []),
          ].join("\n"),
        ),
      );
    },

    async report(offer, kind, text, links = []) {
      // The offer's origin is from when the item was offered; threads attached since are only known to the office.
      const granted = await office.chatReport(offer.workItem.id, kind);
      if (!granted.post) {
        return;
      }

      const origin = offer.workItem.origin;
      await deliver(kind, text, [...links, ...granted.links], {
        ...(granted.direct ? { direct: granted.direct } : {}),
        threads: granted.threads?.length ? granted.threads : origin ? [origin] : [],
      });
    },

    async postQueued(reports) {
      for (const r of reports) {
        if (!postedReports.has(r.id)) {
          try {
            await deliver(
              r.kind,
              r.text,
              r.links,
              { ...(r.direct ? { direct: r.direct } : {}), threads: r.threads ?? [] },
              true,
            );

            postedReports.add(r.id);
          } catch (e) {
            // Not confirmed: the office sends it again with the next connection.
            log.warn("could not post a queued report", {
              workItemId: r.workItemId,
              error: reason(e),
            });

            continue;
          }
        }

        // Confirm a report posted earlier too: the first confirmation may have been lost.
        await office.reportPosted(r.workItemId, r.id).catch((e: unknown) => {
          log.warn("could not confirm a posted report", {
            workItemId: r.workItemId,
            error: reason(e),
          });
        });
      }
    },
  };
}
