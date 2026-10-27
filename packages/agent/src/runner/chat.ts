import { createTicketLinker, policyOn, silentLogger, type ChatMessage } from "@outstaff/core";
import {
  formatWorkGroups,
  groupWork,
  type Link,
  type QueuedReport,
  type WorkSummary,
} from "@outstaff/protocol";
import type { ChatReportKind } from "../verbs/office.types.js";
import { saveAttachments } from "./attachments.js";
import { acknowledgement } from "./chat-acknowledge.js";
import { fromTrustedHuman, linksToList, officeMessage, reportBody } from "./chat-report.js";
import type { ChatRelayOptions, ChatRelay, ReportDestination, ReportTarget } from "./chat.types.js";
import { chatContext } from "./chat-context.js";
import { placementQuestion, replyFor } from "./chat-replies.js";
import { linkLine, splitReply, tag } from "./chat-text.js";
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

  /** Passes the message to the office; when it cannot be reached, says so in the thread and gives up. */
  async function toOffice(m: ChatMessage, participant: boolean, thread: string) {
    try {
      return await office.chatMessage(officeMessage(m, participant));
    } catch (e) {
      log.warn("the office did not take a chat message", { error: reason(e) });
      await post(
        m.channel,
        thread,
        "I could not reach the office just now. Please ask again in a moment.",
      );

      return undefined;
    }
  }

  async function onMessage(m: ChatMessage) {
    // The adapter filters already; the relay never relies on that alone.
    if (!fromTrustedHuman(m)) {
      return;
    }

    const thread = m.thread ?? m.id;
    const participant = await takesPart(m);
    if (acknowledge) {
      chat.react(m.channel, m.id, "eyes").catch(() => {});
    }

    const result = await toOffice(m, participant, thread);
    if (!result || result.repeated) {
      return;
    }

    const text = replyFor(result, hasPm, describe);
    if (text) {
      await post(m.channel, thread, linked(text));
    }
  }

  /** Where a report goes: the threads it belongs to, else a direct message with the requester (no thread, no mention). */
  async function reportTargets(where: ReportDestination): Promise<ReportTarget[]> {
    const targets = where.threads.map((t) => ({
      channel: t.channel,
      thread: t.thread,
      mention: tag(t),
    }));

    if (!where.direct || targets.length > 0) {
      return targets;
    }

    return [{ channel: await chat.openDirect(where.direct), mention: "" }];
  }

  /** Posts a reply split into parts: the mention leads the first, the links follow the last. */
  async function postParts(t: ReportTarget, parts: string[], links: Link[], strict: boolean) {
    for (const [i, part] of parts.entries()) {
      const mention = i === 0 ? t.mention : "";
      const trailer = i === parts.length - 1 ? links.map(linkLine) : [];
      await post(t.channel, t.thread, [linked(`${mention}${part}`), ...trailer].join("\n"), strict);
    }
  }

  /** Posts a report in the threads it belongs to, or in a direct message with the requester. */
  async function deliver(
    kind: Exclude<ChatReportKind, "ack">,
    text: string,
    links: Link[],
    where: ReportDestination,
    strict = false,
  ) {
    const body = reportBody(kind, text);
    const listed = linksToList(links, body);
    const parts = splitReply(body);
    for (const t of await reportTargets(where)) {
      await postParts(t, parts, listed, strict);
    }
  }

  /** Posts a queued report once, and confirms it to the office; one that cannot be posted is left for next time. */
  async function postQueuedReport(r: QueuedReport) {
    if (!postedReports.has(r.id)) {
      try {
        const where = { ...(r.direct ? { direct: r.direct } : {}), threads: r.threads ?? [] };
        await deliver(r.kind, r.text, r.links, where, true);
        postedReports.add(r.id);
      } catch (e) {
        // Not confirmed: the office sends it again with the next connection.
        log.warn("could not post a queued report", { workItemId: r.workItemId, error: reason(e) });
        return;
      }
    }

    // Confirm a report posted earlier too: the first confirmation may have been lost.
    await office.reportPosted(r.workItemId, r.id).catch((e: unknown) => {
      log.warn("could not confirm a posted report", { workItemId: r.workItemId, error: reason(e) });
    });
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

      await post(
        origin.channel,
        origin.thread,
        linked(
          [
            `${tag(origin)}${acknowledgement(what, filed, ticketUrl)}`,
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
        await postQueuedReport(r);
      }
    },
  };
}
