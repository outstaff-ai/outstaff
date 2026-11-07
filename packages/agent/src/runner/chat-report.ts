import type { ChatMessage } from "@outstaff/core";
import { MAX_CHAT_FILES, type Link } from "@outstaff/protocol";
import type { ChatMessageRequest, ChatReportKind } from "#/verbs/office.types.js";
import { clip } from "./chat-text.js";

/** How the agent words each kind of report: its own words, but for a failure, which is the runtime speaking. */
const REPORT_BODIES: Record<Exclude<ChatReportKind, "ack">, (text: string) => string> = {
  result: (text) => text.trim(),
  blocked: (text) => text.trim(),
  failed: (text) =>
    `I hit an error and could not finish this. I will try again. ${clip(text, 1).slice(0, 300)}`,
};

export const reportBody = (kind: Exclude<ChatReportKind, "ack">, text: string) =>
  REPORT_BODIES[kind](text);

/** What a blocked report says: the agent's message for the human, else its summary, else that the ticket is blocked. */
export const blockedText = (words: {
  message?: string | undefined;
  summary: string;
  ticket?: string | undefined;
}) => words.message?.trim() || words.summary.trim() || `${words.ticket ?? "This work"} is blocked.`;

/** The links to list under a report: each once, and none the body already shows. */
export const linksToList = (links: Link[], body: string) =>
  links.filter((l, i, a) => a.findIndex((x) => x.url === l.url) === i && !body.includes(l.url));

/** Messages the relay passes to the office are from trusted humans only; the adapter filters too. */
export const fromTrustedHuman = (m: ChatMessage) => m.author.trusted && !m.author.bot;

/** What the office is told of a trusted human's message. */
export function officeMessage(m: ChatMessage, participant: boolean): ChatMessageRequest {
  return {
    messageId: m.id,
    channel: m.channel,
    ...(m.thread ? { thread: m.thread } : {}),
    text: m.text,
    author: { id: m.author.id, ...(m.author.name ? { name: m.author.name } : {}) },
    direct: m.direct ?? false,
    participant,
    ...(m.files?.length ? { files: m.files.slice(0, MAX_CHAT_FILES) } : {}),
  };
}
