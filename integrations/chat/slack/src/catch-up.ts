import type { ChatMessage, ChatMissed, ChatMissedOptions } from "@outstaff/core";
import type { SlackMessage, SlackPage } from "./api.js";
import { isContentSubtype, isoOf } from "./chat-message.js";
import { readPages } from "./history.js";
import type { CatchUpDeps, MissedConversation } from "./types.js";

/** The most messages read back in one conversation: the latest ones. */
const READ_CAP = 1000;
const PAGE = 200;

/** ISO-8601 as a Slack timestamp, for `oldest`. Slack keeps microseconds; the cursor has milliseconds. */
const tsOf = (iso: string) => (Date.parse(iso) / 1000).toFixed(6);

const keyOf = (channel: string, thread?: string) => `${channel}:${thread ?? ""}`;

/** A direct message channel has an id that starts with D. */
const isDirect = (channel: string) => channel.startsWith("D");

/** A message a person wrote, not the bot and not an edit, join or other event. */
const isPersonContent = (m: SlackMessage, bot: string) =>
  Boolean(m.ts && m.user) && !m.bot_id && m.user !== bot && isContentSubtype(m.subtype);

/** What `start` would have delivered: a person's message in a direct message, or one that mentions the bot. */
const isRequestRow = (m: SlackMessage, channel: string, bot: string) =>
  isPersonContent(m, bot) && (isDirect(channel) || (m.text ?? "").includes(`<@${bot}>`));

/** A thread's parent carries its own ts as `thread_ts` in history; as a message it is top-level. */
function asSent(m: SlackMessage): SlackMessage {
  const { thread_ts: thread, ...rest } = m;
  return thread === m.ts ? rest : m;
}

/** The conversations to read: each one with a cursor, and the direct messages with the team's humans without one. */
function conversationsOf(opts: ChatMissedOptions, directs: string[]) {
  const out = new Map<string, MissedConversation>();
  for (const c of opts.cursors) {
    out.set(keyOf(c.channel, c.thread), {
      channel: c.channel,
      ...(c.thread ? { thread: c.thread } : {}),
      after: c.at,
    });
  }

  for (const channel of directs.filter((d) => !out.has(keyOf(d)))) {
    out.set(keyOf(channel), { channel, after: opts.since });
  }

  return out;
}

/**
 * Threads not known already whose parent is in what was read of the conversation: their replies are later still.
 */
function threadsIn(c: MissedConversation, rows: SlackMessage[], known: Map<string, unknown>) {
  return rows
    .filter((m) => m.latest_reply && !known.has(keyOf(c.channel, m.ts)))
    .map((m) => ({ channel: c.channel, thread: m.ts!, after: c.after }));
}

/**
 * Catch-up over the conversations history and replies APIs: the requests written to the agent after each cursor,
 * and since `since` in the direct messages with the team's humans that have no cursor, with the threads that got
 * replies meanwhile. The same filter as Socket Mode applies; a conversation Slack refuses (a missing scope, a
 * channel the bot left) is logged and left out.
 */
export async function missedSince(
  deps: CatchUpDeps,
  opts: ChatMissedOptions,
): Promise<ChatMissed[]> {
  const bot = await deps.botUserId();
  const known = conversationsOf(opts, await deps.directs());
  const read = async (c: MissedConversation) => {
    try {
      return await readConversation(deps, c);
    } catch (error) {
      deps.log.warn("could not read a Slack conversation to catch up", {
        channel: c.channel,
        error: String(error),
      });

      return [];
    }
  };

  const out: ChatMissed[] = [];
  const top = [...known.values()].filter((c) => !c.thread);
  for (const c of top) {
    const rows = await read(c);
    for (const t of threadsIn(c, rows, known)) {
      known.set(keyOf(t.channel, t.thread), t);
    }

    out.push(await missedIn(deps, c, rows, bot, opts));
  }

  for (const c of [...known.values()].filter((x) => x.thread)) {
    out.push(await missedIn(deps, c, await read(c), bot, opts));
  }

  return out.filter((c) => c.messages.length > 0 || c.skipped > 0);
}

/** A conversation's messages after where it left off, oldest first: a thread's replies, or the channel's top level. */
async function readConversation(deps: CatchUpDeps, c: MissedConversation) {
  const oldest = tsOf(c.after);
  const page = (args: { cursor?: string }): Promise<SlackPage> =>
    c.thread
      ? deps.web.conversations.replies({
          channel: c.channel,
          ts: c.thread,
          oldest,
          limit: PAGE,
          ...args,
        })
      : deps.web.conversations.history({ channel: c.channel, oldest, limit: PAGE, ...args });

  return readPages((cursor) => page(cursor ? { cursor } : {}), READ_CAP, !c.thread);
}

/** The conversation's requests from trusted humans: the latest `limit` since `since`, and how many are left out. */
async function missedIn(
  deps: CatchUpDeps,
  c: MissedConversation,
  rows: SlackMessage[],
  bot: string,
  opts: ChatMissedOptions,
): Promise<ChatMissed> {
  const fresh = rows
    .filter((m) => isRequestRow(m, c.channel, bot) && isoOf(m.ts!) > c.after)
    .filter((m) => deps.remember(`${c.channel}:${m.ts}`));

  const all = await Promise.all(fresh.map((m) => deps.toMessage(c.channel, asSent(m))));
  const trusted = all.filter((m: ChatMessage) => m.author.trusted && !m.author.bot);
  const kept = trusted.filter((m) => m.at >= opts.since).slice(-opts.limit);
  return {
    channel: c.channel,
    ...(c.thread ? { thread: c.thread } : {}),
    ...(isDirect(c.channel) ? { direct: true } : {}),
    messages: kept,
    skipped: trusted.length - kept.length,
  };
}
