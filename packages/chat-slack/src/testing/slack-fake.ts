import type { ChatSeed, InboundMessage } from "@outstaff/core/contracts";
import type { ChatMessage } from "@outstaff/core";
import type {
  SlackEvent,
  SlackHomeView,
  SlackMessage,
  SlackSocket,
  SlackUser,
  SlackWeb,
} from "../api.js";

export const BOT_USER = "U-bot";

/** A Slack platform error as the SDK throws it. */
export function slackError(error: string): Error {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error },
  });
}

export interface FakeSlack {
  web: SlackWeb;
  socket: SlackSocket & { started: boolean };
  seed: ChatSeed;

  /** Every chat.postMessage, in order. */
  posts: { channel: string; text: string; thread_ts?: string }[];
  reactions: { channel: string; timestamp: string; name: string }[];
  views: { user_id: string; view: SlackHomeView }[];
  usersInfoCalls: string[];
  users: Map<string, SlackUser>;

  /** Deliver a raw Events API event to the adapter and wait for it to finish. */
  emit(event: SlackEvent): Promise<void>;

  /** A message from `user` in a direct channel, as Slack delivers it. */
  directMessage(user: string, text: string, extra?: Partial<SlackEvent>): Promise<void>;
}

/** A stateful stand-in for Slack's Web API and Socket Mode, enough for the chat contract kit. */
export function createFakeSlack(): FakeSlack {
  let clock = 1_767_225_600;
  let counter = 0;
  const stored = new Map<string, SlackMessage[]>();
  const users = new Map<string, SlackUser>();
  const posts: FakeSlack["posts"] = [];
  const reactions: FakeSlack["reactions"] = [];
  const views: FakeSlack["views"] = [];
  const usersInfoCalls: string[] = [];
  let handler: ((e: SlackEvent) => Promise<void>) | undefined;

  const nextTs = () => `${clock++}.${String(++counter).padStart(6, "0")}`;
  const inChannel = (channel: string) => {
    let list = stored.get(channel);
    if (!list) {
      list = [];
      stored.set(channel, list);
    }

    return list;
  };

  const byTs = (channel: string, ts: string) => inChannel(channel).find((m) => m.ts === ts);
  const page = (messages: SlackMessage[], limit = 100, cursor?: string) => {
    const start = cursor ? Number(cursor) : 0;
    const slice = messages.slice(start, start + limit);
    const next = start + limit < messages.length ? String(start + limit) : "";
    return { messages: structuredClone(slice), response_metadata: { next_cursor: next } };
  };

  users.set(BOT_USER, { id: BOT_USER, name: "acme-bot", is_bot: true });

  const web: SlackWeb = {
    auth: { test: async () => ({ user_id: BOT_USER }) },
    users: {
      async info({ user }) {
        usersInfoCalls.push(user);
        const found = users.get(user);
        if (!found) {
          throw slackError("user_not_found");
        }

        return { user: structuredClone(found) };
      },
    },
    chat: {
      async postMessage({ channel, text, thread_ts }) {
        const ts = nextTs();
        posts.push({ channel, text, ...(thread_ts ? { thread_ts } : {}) });
        inChannel(channel).push({
          ts,
          text,
          user: BOT_USER,
          bot_id: "B-self",
          ...(thread_ts ? { thread_ts } : {}),
        });

        return { ts, channel };
      },
    },
    reactions: {
      async add(args) {
        if (!byTs(args.channel, args.timestamp)) {
          throw slackError("message_not_found");
        }

        if (reactions.some((r) => r.timestamp === args.timestamp && r.name === args.name)) {
          throw slackError("already_reacted");
        }

        reactions.push(args);
        return { ok: true };
      },
    },
    conversations: {
      async history({ channel, limit, cursor }) {
        const top = inChannel(channel).filter((m) => !m.thread_ts || m.thread_ts === m.ts);
        return page(top.toReversed(), limit, cursor);
      },
      async replies({ channel, ts, limit, cursor }) {
        const thread = inChannel(channel).filter((m) => m.ts === ts || m.thread_ts === ts);
        return page(thread, limit, cursor);
      },
      async open({ users: user }) {
        return { channel: { id: `D-${user}` } };
      },
    },
    views: {
      async publish(args) {
        views.push(structuredClone(args));
        return { ok: true };
      },
    },
  };

  const socket: FakeSlack["socket"] = {
    started: false,
    onEvent(h) {
      handler = h;
    },
    async start() {
      socket.started = true;
    },
    async stop() {
      socket.started = false;
    },
  };

  const emit = async (event: SlackEvent) => {
    await handler?.(event);
  };

  const seed: ChatSeed = {
    channel: "C-general",
    userId: "U-noor",
    async inbound(m: InboundMessage): Promise<ChatMessage> {
      const bot = m.bot ?? false;
      if (!users.has(m.authorId)) {
        // Trusted people are full members; the rest are guests, so the default trust rule decides.
        users.set(m.authorId, {
          id: m.authorId,
          name: m.authorId.toLowerCase(),
          is_bot: bot,
          is_restricted: !(m.trusted ?? true),
        });
      }

      const ts = nextTs();
      const row = {
        ts,
        text: m.text,
        user: m.authorId,
        ...(m.thread ? { thread_ts: m.thread } : {}),
      };

      inChannel(m.channel).push(row);
      await emit({
        type: "app_mention",
        channel: m.channel,
        ts,
        user: m.authorId,
        text: `<@${BOT_USER}> ${m.text}`,
        ...(bot ? { bot_id: m.authorId } : {}),
        ...(m.thread ? { thread_ts: m.thread } : {}),
      });

      return {
        id: ts,
        channel: m.channel,
        author: { id: m.authorId, trusted: m.trusted ?? true, bot },
        text: m.text,
        at: new Date().toISOString(),
      };
    },
  };

  return {
    web,
    socket,
    seed,
    posts,
    reactions,
    views,
    usersInfoCalls,
    users,
    emit,
    async directMessage(user, text, extra = {}) {
      await emit({
        type: "message",
        channel_type: "im",
        channel: `D-${user}`,
        user,
        text,
        ts: nextTs(),
        ...extra,
      });
    },
  };
}
