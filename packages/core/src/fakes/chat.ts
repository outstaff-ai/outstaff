import type { ChatSeed, InboundMessage } from "../contracts/seeds.js";
import { PortError, splitAtLines } from "../ports/index.js";
import type { Chat, ChatMessage, AgentProfile } from "../ports/index.js";
import { steppingClock } from "./util.js";

export interface FakeChatOptions {
  /** Posts longer than this are split at line breaks, as a real adapter does. Default 4000. */
  maxMessageLength?: number;
  now?: () => Date;
}

export interface FakeChat extends Chat {
  seed: ChatSeed;

  /** Every message the adapter posted, one entry per platform message. */
  posts: ChatMessage[];
  reactions: { channel: string; messageId: string; name: string }[];
  profiles: Map<string, AgentProfile>;
}

export function createFakeChat(opts: FakeChatOptions = {}): FakeChat {
  const max = opts.maxMessageLength ?? 4000;
  const now = opts.now ?? steppingClock();
  const messages: ChatMessage[] = [];
  const posts: ChatMessage[] = [];
  const reactions: FakeChat["reactions"] = [];
  const profiles = new Map<string, AgentProfile>();
  let handler: ((m: ChatMessage) => Promise<void>) | undefined;
  let counter = 0;

  const build = (
    m: InboundMessage | { channel: string; thread?: string; text: string },
    author: ChatMessage["author"],
  ): ChatMessage => {
    const message: ChatMessage = {
      id: `m${++counter}`,
      channel: m.channel,
      author,
      text: m.text,
      at: now().toISOString(),
    };

    if (m.thread !== undefined) {
      message.thread = m.thread;
    }

    messages.push(message);
    return message;
  };

  return {
    posts,
    reactions,
    profiles,
    seed: {
      channel: "C-general",
      userId: "U-noor",
      async inbound(m) {
        const author: ChatMessage["author"] = {
          id: m.authorId,
          trusted: m.trusted ?? true,
          bot: m.bot ?? false,
        };

        if (m.authorName !== undefined) {
          author.name = m.authorName;
        }

        const message = build(m, author);
        // An adapter drops messages from people it does not trust or from its own bot before they reach the office.
        if (handler && author.trusted && !author.bot) {
          await handler(structuredClone(message));
        }

        return message;
      },
    },
    async start(onMessage) {
      handler = onMessage;
    },
    async stop() {
      handler = undefined;
    },
    async post(channel, markdown, o = {}) {
      const chunks = splitAtLines(markdown, max);
      let first: ChatMessage | undefined;
      for (const text of chunks) {
        const m = build(
          { channel, text, ...(o.thread !== undefined ? { thread: o.thread } : {}) },
          { id: "bot", trusted: true, bot: true },
        );

        first ??= m;
        if (!m.thread) {
          m.thread = first.id;
        }

        posts.push(m);
      }

      return { id: first!.id, thread: first!.thread! };
    },
    async react(channel, messageId, name) {
      if (!messages.some((m) => m.id === messageId && m.channel === channel)) {
        throw new PortError("not_found", `Message ${messageId} not found in ${channel}.`);
      }

      reactions.push({ channel, messageId, name });
    },
    async history(channel, o) {
      const inChannel = messages.filter(
        (m) =>
          m.channel === channel &&
          (o.thread === undefined || m.thread === o.thread || m.id === o.thread),
      );

      return structuredClone(inChannel.slice(-o.limit));
    },
    async openDirect(userId) {
      return `D-${userId}`;
    },
    async setAgentProfile(userId, profile) {
      profiles.set(userId, structuredClone(profile));
    },
  };
}
