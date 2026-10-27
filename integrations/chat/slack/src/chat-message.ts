import type { ChatMessage } from "@outstaff/core";
import type { SlackEvent, SlackMessage } from "./api.js";
import { filesOf } from "./files.js";
import type { Sender } from "./types.js";

/** Message subtypes that are a person's own content; edits, deletes, joins and bot messages are not requests. */
const CONTENT_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

const isoOf = (ts: string) => new Date(Number(ts) * 1000).toISOString();

/** Whether the event is someone opening the agent's Home tab. */
export function isHomeOpened(e: SlackEvent): boolean {
  return e.type === "app_home_opened" && e.tab === "home" && Boolean(e.user);
}

/** Whether a message event is a person's own content in a direct message. A message with files arrives as `file_share`. */
function isDirectContent(e: SlackEvent): boolean {
  return e.channel_type === "im" && (!e.subtype || CONTENT_SUBTYPES.has(e.subtype));
}

/** Whether the event names a person, a channel and a message, and does not come from a bot. */
function isFromPerson(e: SlackEvent): boolean {
  return !e.bot_id && Boolean(e.user && e.channel && e.ts);
}

/** Direct messages and mentions only; edits, joins and other subtypes are not requests. */
export function isRequest(e: SlackEvent): boolean {
  if (e.type === "app_mention") {
    return isFromPerson(e);
  }

  return e.type === "message" && isDirectContent(e) && isFromPerson(e);
}

/** Builds the port's message from a Slack message, its resolved sender and its cleaned text. */
export function chatMessageOf(
  channel: string,
  m: SlackMessage,
  author: { id: string; sender: Sender },
  text: string,
): ChatMessage {
  const { id, sender } = author;
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
    text,
    at: isoOf(m.ts!),
    ...(direct ? { direct } : {}),
    ...(files.length ? { files } : {}),
  };
}
