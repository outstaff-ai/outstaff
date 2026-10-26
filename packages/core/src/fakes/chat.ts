import type { InboundMessage } from "../contracts/seeds.js";
import { PortError, splitAtLines } from "../ports/index.js";
import type { ChatFile, ChatMessage, AgentProfile } from "../ports/index.js";
import type { FakeChat, FakeChatOptions } from "./types.js";
import { steppingClock } from "./util.js";

export function createFakeChat(opts: FakeChatOptions = {}): FakeChat {
  const max = opts.maxMessageLength ?? 4000;
  const now = opts.now ?? steppingClock();
  const messages: ChatMessage[] = [];
  const posts: ChatMessage[] = [];
  const reactions: FakeChat["reactions"] = [];
  const profiles = new Map<string, AgentProfile>();
  const profileLog: FakeChat["profileLog"] = [];
  const files = new Map<string, Uint8Array>();
  let profileSource: Parameters<FakeChat["onProfileRequest"]>[0] | undefined;
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

    // Like a real adapter, mark messages in a direct message conversation (the fake's ids start with D).
    if (m.channel.startsWith("D")) {
      message.direct = true;
    }

    if ("files" in m && m.files?.length) {
      message.files = m.files.map((f): ChatFile => {
        const id = `F${files.size + 1}`;
        files.set(id, f.data);
        return {
          id,
          name: f.name,
          mimetype: f.mimetype,
          size: f.data.byteLength,
          url: `https://files.chat.acme.example/${id}/${encodeURIComponent(f.name)}`,
        };
      });
    }

    messages.push(message);
    return message;
  };

  return {
    posts,
    reactions,
    profiles,
    profileLog,
    files,
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
    async download(file) {
      const data = files.get(file.id);
      if (!data) {
        throw new PortError("not_found", `File ${file.id} not found.`);
      }

      return data.slice();
    },
    async openDirect(userId) {
      return `D-${userId}`;
    },
    onProfileRequest(source) {
      profileSource = source;
    },
    async openProfile(userId) {
      return profileSource?.(userId);
    },
    async setAgentProfile(userId, profile) {
      profiles.set(userId, structuredClone(profile));
      profileLog.push({ userId, profile: structuredClone(profile) });
    },
  };
}
