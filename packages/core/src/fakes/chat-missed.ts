import type { ChatCursor, ChatMessage, ChatMissed, ChatMissedOptions } from "#/ports/index.js";

const keyOf = (m: { channel: string; thread?: string | undefined }) =>
  `${m.channel}:${m.thread ?? ""}`;

/** Whether the message is one `start` delivers: a trusted human's, in a direct message or a known conversation. */
const isRequest = (m: ChatMessage, cursor: ChatCursor | undefined) =>
  m.author.trusted && !m.author.bot && (cursor !== undefined || m.channel.startsWith("D"));

/** A conversation's group of missed messages, created the first time one of its messages comes. */
function groupOf(groups: Map<string, ChatMissed>, m: ChatMessage): ChatMissed {
  const key = keyOf(m);
  const group = groups.get(key) ?? {
    channel: m.channel,
    ...(m.thread ? { thread: m.thread } : {}),
    ...(m.direct ? { direct: true } : {}),
    messages: [],
    skipped: 0,
  };

  groups.set(key, group);
  return group;
}

/** The fake's catch-up: the requests after each conversation's cursor, newest `limit` kept, in time order. */
export function missedIn(messages: ChatMessage[], opts: ChatMissedOptions): ChatMissed[] {
  const cursors = new Map(opts.cursors.map((c) => [keyOf(c), c]));
  const groups = new Map<string, ChatMissed>();
  for (const m of messages) {
    const cursor = cursors.get(keyOf(m));
    if (isRequest(m, cursor) && m.at > (cursor?.at ?? opts.since)) {
      const group = groupOf(groups, m);
      if (m.at < opts.since) {
        group.skipped++;
      } else {
        group.messages.push(structuredClone(m));
      }
    }
  }

  return [...groups.values()].map((g) => {
    const over = Math.max(0, g.messages.length - opts.limit);
    return { ...g, messages: g.messages.slice(over), skipped: g.skipped + over };
  });
}
