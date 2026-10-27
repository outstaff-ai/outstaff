import type { ChatSeed, InboundMessage } from "@outstaff/core/contracts";
import type { ChatMessage } from "@outstaff/core";
import type { SlackEvent, SlackFile, SlackMessage, SlackUser, SlackWeb } from "#/api.js";
import type { FakeSlack } from "./types.js";

export const BOT_USER = "U-bot";
export const BOT_TOKEN = "xoxb-test";
export const FILES_HOST = "https://files.slack.com";

/** A Slack platform error as the SDK throws it. */
/** The optional thread and files of a message row or event. */
const extrasOf = (thread: string | undefined, shared: SlackFile[]) => ({
  ...(thread ? { thread_ts: thread } : {}),
  ...(shared.length ? { files: shared } : {}),
});

export function slackError(error: string): Error {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error },
  });
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
  const files: FakeSlack["files"] = new Map();
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

  /** Trusted people are full members; the rest are guests, so the default trust rule decides. */
  const ensureUser = (m: InboundMessage, bot: boolean) => {
    if (!users.has(m.authorId)) {
      users.set(m.authorId, {
        id: m.authorId,
        name: m.authorId.toLowerCase(),
        is_bot: bot,
        is_restricted: !(m.trusted ?? true),
      });
    }
  };

  const share = (attached: InboundMessage["files"] = []): SlackFile[] =>
    attached.map((f) => {
      const id = `F${files.size + 1}`;
      files.set(id, f);
      return {
        id,
        name: f.name,
        mimetype: f.mimetype,
        size: f.data.byteLength,
        url_private_download: `${FILES_HOST}/files-pri/T0-${id}/download/${encodeURIComponent(f.name)}`,
      };
    });

  const seed: ChatSeed = {
    channel: "C-general",
    userId: "U-noor",
    async inbound(m: InboundMessage): Promise<ChatMessage> {
      const bot = m.bot ?? false;
      ensureUser(m, bot);
      const ts = nextTs();
      const extras = extrasOf(m.thread, share(m.files));
      const row = { ts, text: m.text, user: m.authorId, ...extras };

      inChannel(m.channel).push(row);
      await emit({
        type: "app_mention",
        channel: m.channel,
        ts,
        user: m.authorId,
        text: `<@${BOT_USER}> ${m.text}`,
        ...(bot ? { bot_id: m.authorId } : {}),
        ...extras,
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

  const fileHost = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const id = /\/files-pri\/T0-(F\d+)\//.exec(url.pathname)?.[1];
    const file = id ? files.get(id) : undefined;
    if (url.origin !== FILES_HOST || !file) {
      return new Response("not found", { status: 404 });
    }

    // Slack answers a token without files:read with a sign-in page, not an error status.
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${BOT_TOKEN}`) {
      return new Response("<html>Sign in</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }

    return new Response(file.data.slice(), { headers: { "content-type": file.mimetype } });
  }) as typeof fetch;

  return {
    web,
    socket,
    seed,
    files,
    fetch: fileHost,
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
