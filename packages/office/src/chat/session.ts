import type { PayloadOf } from "@outstaff/protocol";
import type { Store } from "#/store/types.js";
import { CHAT_ORIGIN_SUBJECT, CHAT_THREAD_SUBJECT, threadKey } from "./origin.js";
import { messageMentions, messageRefs } from "./refs.js";
import type { ChatOriginRecord } from "./types.js";

type Message = PayloadOf<"chat_message">;
type SessionStore = Pick<Store, "getSubject" | "upsertSubject" | "addItemRefs">;

/** The message a `chat.message` event carries, as the agent passed it on; undefined for any other event. */
export function messageOf(data: Record<string, unknown>): Message | undefined {
  const m = data["message"] as Partial<Message> | undefined;
  return typeof m?.channel === "string" && typeof m.messageId === "string"
    ? (m as Message)
    : undefined;
}

/** A chat session's title: the message's first line, else its first file's name. */
export function chatTitle(m: Pick<Message, "text" | "files">): string {
  const line = m.text.split("\n", 1)[0]!.trim();
  const short = line.length > 80 ? `${line.slice(0, 79)}…` : line;
  return `Chat: ${short || m.files?.[0]?.name || "(no text)"}`;
}

/**
 * Makes a work item the pipeline queued for a chat message a chat session, as the chat desk does for the session it
 * starts: the thread to answer in and the requester (so the filing verbs and the reports work), and the message and
 * the tickets it names as what woke it.
 */
export async function openChatSession(store: SessionStore, itemId: string, m: Message) {
  const thread = m.thread ?? m.messageId;
  const origin: ChatOriginRecord = {
    channel: m.channel,
    thread,
    requester: { id: m.author.id, ...(m.author.name ? { name: m.author.name } : {}) },
    direct: m.direct,
    participant: m.participant,
    awaitingPlacement: false,
    claimed: [],
    text: m.text,
    ...(m.files?.length ? { files: m.files } : {}),
  };

  await store.upsertSubject(CHAT_ORIGIN_SUBJECT, itemId, origin);
  await store.upsertSubject(CHAT_THREAD_SUBJECT, threadKey(m.channel, thread), { itemId });
  await store.addItemRefs(itemId, [
    ...messageRefs(m, "trigger"),
    ...(await messageMentions(store, m)),
  ]);
}

/** A later message of the conversation, folded into its session: its thread and the tickets it names. */
export async function joinChatSession(store: SessionStore, itemId: string, m: Message) {
  await store.addItemRefs(itemId, [
    ...messageRefs(m, "attached"),
    ...(await messageMentions(store, m)),
  ]);
}
