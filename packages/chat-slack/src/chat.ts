import { WebClient } from "@slack/web-api";
import {
  PortError,
  type AdapterContext,
  type AgentProfile,
  type Chat,
  type ChatFile,
  type ChatMessage,
} from "@outstaff/core";
import type {
  SlackEvent,
  SlackFile,
  SlackMessage,
  SlackPage,
  SlackSocket,
  SlackWeb,
} from "./api.js";
import { slackErrorName, toPortError } from "./errors.js";
import { splitMrkdwn, toMrkdwn } from "./mrkdwn.js";
import type { SlackOptions } from "./options.js";
import { homeView } from "./profile.js";
import { createSocketModeSocket } from "./socket.js";
import { createTrust } from "./trust.js";

const REACTIONS = { eyes: "eyes", done: "white_check_mark", error: "x" } as const;
const SEEN_LIMIT = 500;

/** A held profile is shown as it is for this long after it was published; then the agent is asked again. */
const PROFILE_FRESH_MS = 60_000;
const ZONE_TTL_MS = 10 * 60_000;
const PAGE = 200;

/** Replace the web or socket client; tests inject fakes, production builds the real ones from secrets. */
export interface SlackDeps {
  web?: SlackWeb;
  socket?: SlackSocket;
}

/** Message subtypes that are a person's own content; edits, deletes, joins and bot messages are not requests. */
const CONTENT_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

/** Files are served from slack.com hosts only; the bot token is never sent anywhere else. */
const isSlackHost = (host: string) => host === "slack.com" || host.endsWith(".slack.com");

const filesOf = (files: SlackFile[] | undefined): ChatFile[] =>
  (files ?? []).flatMap((f) => {
    const url = f.url_private_download ?? f.url_private;
    // A file Slack no longer serves (deleted, over the workspace's limit) has no URL.
    return f.id && url
      ? [
          {
            id: f.id,
            name: f.name ?? f.title ?? f.id,
            mimetype: f.mimetype ?? "application/octet-stream",
            size: f.size ?? 0,
            url,
          },
        ]
      : [];
  });

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
  const profiles = new Map<string, { profile: AgentProfile; at: number }>();
  const zones = new Map<string, { tz?: string; at: number }>();
  let profileSource: ((userId: string) => Promise<AgentProfile | undefined>) | undefined;

  const trust = createTrust({
    web,
    humans: ctx.team.humans,
    botUserId: () => botUserId,
    now: ctx.now,
    log: ctx.log,
  });

  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw toPortError(error);
    }
  };

  const ensureBotUserId = async () => {
    if (!botUserId) {
      botUserId = (await call(() => web.auth.test())).user_id;
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
        let held = profiles.get(e.user);
        const stale = !held || ctx.now().getTime() - held.at >= PROFILE_FRESH_MS;
        // Only trusted people see the work; a profile held for a person was published for them.
        if (profileSource && stale && (held || (await trust.resolve(e.user)).trusted)) {
          try {
            const fresh = await profileSource(e.user);
            if (fresh) {
              held = { profile: structuredClone(fresh), at: ctx.now().getTime() };
              profiles.set(e.user, held);
            }
          } catch (error) {
            ctx.log.warn("could not refresh the profile; showing the one held", {
              error: String(error),
            });
          }
        }

        if (held) {
          await publish(e.user, held.profile);
        }

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

  /** The viewer's timezone from Slack, cached with the other lookups; unknown when the lookup fails. */
  const zoneOf = async (userId: string) => {
    const now = ctx.now().getTime();
    const hit = zones.get(userId);
    if (hit && now - hit.at < ZONE_TTL_MS) {
      return hit.tz;
    }

    let tz: string | undefined;
    try {
      tz = (await web.users.info({ user: userId })).user?.tz || undefined;
    } catch {
      // Times show in UTC.
    }

    zones.set(userId, { ...(tz ? { tz } : {}), at: now });
    return tz;
  };

  const publish = async (userId: string, profile: AgentProfile) => {
    const tz = profile.lastActiveAt ? await zoneOf(userId) : undefined;
    await call(() => web.views.publish({ user_id: userId, view: homeView(profile, tz) }));
  };

  const pages = async (
    fetchPage: (cursor?: string) => Promise<SlackPage>,
    limit: number,
    newestFirst: boolean,
  ) => {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(() => fetchPage(cursor));
      out.push(...(page.messages ?? []));
      cursor = page.response_metadata?.next_cursor || undefined;
      // History pages run newest first, so enough of them is enough; thread pages run oldest first and need all.
    } while (cursor && (!newestFirst || out.length < limit));

    return newestFirst ? out.slice(0, limit).toReversed() : out.slice(-limit);
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
      await call(() => socket!.start());
    },

    async stop() {
      handler = undefined;
      await socket?.stop();
    },

    async post(channel, markdown, opts = {}) {
      let first: string | undefined;
      for (const text of splitMrkdwn(toMrkdwn(markdown))) {
        const thread = opts.thread ?? first;
        const sent = await call(() =>
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
        ? await pages(
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
        : await pages(
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
      let url: URL;
      try {
        url = new URL(file.url);
      } catch {
        throw new PortError("invalid", `File ${file.id} has no valid download address.`);
      }

      if (url.protocol !== "https:" || !isSlackHost(url.hostname)) {
        throw new PortError("invalid", `File ${file.id} is not hosted by Slack.`);
      }

      let res: Response;
      try {
        res = await ctx.fetch(url, { headers: { authorization: `Bearer ${token}` } });
      } catch (error) {
        throw new PortError("unavailable", `Slack could not be reached for file ${file.id}.`, {
          cause: error,
        });
      }

      if (!res.ok) {
        throw new PortError(
          res.status === 401 || res.status === 403 ? "forbidden" : "unavailable",
          `Slack refused file ${file.id}: ${res.status}.`,
        );
      }

      // Without the files:read scope Slack answers 200 with a sign-in page instead of the file.
      if (
        res.headers.get("content-type")?.startsWith("text/html") &&
        !file.mimetype.startsWith("text/html")
      ) {
        throw new PortError(
          "forbidden",
          "Slack sent a web page instead of the file: the app needs the files:read scope.",
        );
      }

      return new Uint8Array(await res.arrayBuffer());
    },

    async openDirect(userId) {
      const known = direct.get(userId);
      if (known) {
        return known;
      }

      const opened = await call(() => web.conversations.open({ users: userId }));
      const id = opened.channel?.id;
      if (!id) {
        throw new PortError("unavailable", "Slack did not return a direct message channel.");
      }

      direct.set(userId, id);
      return id;
    },

    async setAgentProfile(userId, profile) {
      profiles.set(userId, { profile: structuredClone(profile), at: ctx.now().getTime() });
      await publish(userId, profile);
    },

    onProfileRequest(source) {
      profileSource = source;
    },
  };
}
