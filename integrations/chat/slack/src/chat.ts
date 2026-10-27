import { WebClient } from "@slack/web-api";
import { PortError, type AdapterContext, type Chat, type ChatMessage } from "@outstaff/core";
import type { SlackEvent, SlackMessage, SlackWeb } from "./api.js";
import { callSlack, slackErrorName, toPortError } from "./errors.js";
import { downloadSlackFile, filesOf } from "./files.js";
import { readPages } from "./history.js";
import { createHome } from "./home.js";
import { splitMrkdwn, toMrkdwn } from "./mrkdwn.js";
import { createSocketModeSocket } from "./socket.js";
import { createTrust } from "./trust.js";
import type { SlackDeps, SlackOptions } from "./types.js";

const REACTIONS = { eyes: "eyes", done: "white_check_mark", error: "x" } as const;
const SEEN_LIMIT = 500;
const PAGE = 200;

/** Message subtypes that are a person's own content; edits, deletes, joins and bot messages are not requests. */
const CONTENT_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

const isoOf = (ts: string) => new Date(Number(ts) * 1000).toISOString();

function requireToken(ctx: AdapterContext<SlackOptions>, key: string): string {
  const token = ctx.secrets.get(key);
  if (!token) {
    throw new PortError(
      "invalid",
      ctx.scope === "office"
        ? `integrations.chat is configured, but the office has no Slack credentials: set ${key} (the bot token of the team's office Slack app).`
        : `Missing secret ${key}.`,
    );
  }

  return token;
}

export function createSlackChat(ctx: AdapterContext<SlackOptions>, deps: SlackDeps = {}): Chat {
  // WebClient's response types are wider than the slice used here.
  const office = ctx.scope === "office";
  const tokenKey = office ? "SLACK_OFFICE_BOT_TOKEN" : "SLACK_BOT_TOKEN";
  const token = deps.web ? (ctx.secrets.get(tokenKey) ?? "") : requireToken(ctx, tokenKey);
  const web: SlackWeb = deps.web ?? (new WebClient(token) as unknown as SlackWeb);

  let socket = deps.socket;
  let botUserId = ctx.secrets.get("SLACK_BOT_USER_ID");
  let handler: ((m: ChatMessage) => Promise<void>) | undefined;
  const seen = new Set<string>();
  const direct = new Map<string, string>();

  const trust = createTrust({
    web,
    humans: ctx.team.humans,
    botUserId: () => botUserId,
    now: ctx.now,
    log: ctx.log,
  });

  const home = createHome({ ctx, web, trust });

  const ensureBotUserId = async () => {
    if (!botUserId) {
      botUserId = (await callSlack(() => web.auth.test())).user_id;
    }

    return botUserId;
  };

  const clean = (text: string | undefined) =>
    botUserId ? (text ?? "").replaceAll(`<@${botUserId}>`, "").trim() : (text ?? "").trim();

  const toMessage = async (
    channel: string,
    m: SlackMessage,
    userId = m.user,
  ): Promise<ChatMessage> => {
    const id = userId ?? m.bot_id ?? "unknown";
    const own = Boolean(userId) && userId === botUserId;
    const sender =
      m.bot_id || !userId
        ? { bot: true, trusted: own }
        : own
          ? { bot: true, trusted: true }
          : await trust.resolve(userId);

    const thread = m.thread_ts;
    // A direct message channel has an id that starts with D.
    const direct = channel.startsWith("D");
    const files = filesOf(m.files);
    return {
      id: m.ts!,
      channel,
      ...(thread ? { thread } : {}),
      author: {
        id,
        ...(sender.name ? { name: sender.name } : {}),
        trusted: sender.trusted,
        bot: sender.bot,
      },
      text: clean(m.text),
      at: isoOf(m.ts!),
      ...(direct ? { direct } : {}),
      ...(files.length ? { files } : {}),
    };
  };

  const remember = (key: string) => {
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    if (seen.size > SEEN_LIMIT) {
      seen.delete(seen.values().next().value!);
    }

    return true;
  };

  const onEvent = async (e: SlackEvent) => {
    try {
      if (e.type === "app_home_opened" && e.tab === "home" && e.user) {
        await home.opened(e.user);
        return;
      }

      if (e.type !== "message" && e.type !== "app_mention") {
        return;
      }

      // Direct messages and mentions only; edits, joins and other subtypes are not requests. A message with files
      // arrives as `file_share`.
      if (
        e.type === "message" &&
        (e.channel_type !== "im" || (e.subtype && !CONTENT_SUBTYPES.has(e.subtype)))
      ) {
        return;
      }

      if (e.bot_id || !e.user || !e.channel || !e.ts || !handler) {
        return;
      }

      await ensureBotUserId();
      if (e.user === botUserId || !remember(`${e.channel}:${e.ts}`)) {
        return;
      }

      const message = await toMessage(e.channel, e as SlackMessage);
      if (message.author.bot || !message.author.trusted) {
        ctx.log.info("ignoring a message from an untrusted sender", { user: e.user });
        return;
      }

      await handler(message);
    } catch (error) {
      ctx.log.error("handling a Slack event failed", { type: e.type, error: String(error) });
    }
  };

  return {
    async start(onMessage) {
      if (office) {
        throw new PortError(
          "unsupported",
          "The office never listens to chat; it only posts and reads history.",
        );
      }

      handler = onMessage;
      await ensureBotUserId();
      if (!socket) {
        socket = createSocketModeSocket(ctx.secrets.require("SLACK_APP_TOKEN"));
      }

      socket.onEvent(onEvent);
      await callSlack(() => socket!.start());
    },

    async stop() {
      handler = undefined;
      await socket?.stop();
    },

    async post(channel, markdown, opts = {}) {
      let first: string | undefined;
      for (const text of splitMrkdwn(toMrkdwn(markdown))) {
        const thread = opts.thread ?? first;
        const sent = await callSlack(() =>
          web.chat.postMessage({
            channel,
            text,
            unfurl_links: false,
            unfurl_media: false,
            ...(thread ? { thread_ts: thread } : {}),
          }),
        );

        if (!sent.ts) {
          throw new PortError("unavailable", "Slack did not return a message timestamp.");
        }

        first ??= sent.ts;
      }

      return { id: first!, thread: opts.thread ?? first! };
    },

    async react(channel, messageId, name) {
      try {
        await web.reactions.add({ channel, timestamp: messageId, name: REACTIONS[name] });
      } catch (error) {
        if (slackErrorName(error) !== "already_reacted") {
          throw toPortError(error);
        }
      }
    },

    async history(channel, opts) {
      await ensureBotUserId();
      const raw = opts.thread
        ? await readPages(
            (cursor) =>
              web.conversations.replies({
                channel,
                ts: opts.thread!,
                limit: PAGE,
                ...(cursor ? { cursor } : {}),
              }),
            opts.limit,
            false,
          )
        : await readPages(
            (cursor) =>
              web.conversations.history({
                channel,
                limit: Math.min(PAGE, opts.limit),
                ...(cursor ? { cursor } : {}),
              }),
            opts.limit,
            true,
          );

      return Promise.all(raw.filter((m) => m.ts).map((m) => toMessage(channel, m)));
    },

    async download(file) {
      return downloadSlackFile(ctx.fetch, token, file);
    },

    async openDirect(userId) {
      const known = direct.get(userId);
      if (known) {
        return known;
      }

      const opened = await callSlack(() => web.conversations.open({ users: userId }));
      const id = opened.channel?.id;
      if (!id) {
        throw new PortError("unavailable", "Slack did not return a direct message channel.");
      }

      direct.set(userId, id);
      return id;
    },

    async setAgentProfile(userId, profile) {
      await home.set(userId, profile);
    },

    onProfileRequest(source) {
      home.onRequest(source);
    },
  };
}
