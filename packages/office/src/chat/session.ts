import type { PayloadOf } from "@outstaff/protocol";
import { CHAT_KIND } from "#/scheduler/policy.js";
import type { Store, WorkItem } from "#/store/types.js";
import { CHAT_ORIGIN_SUBJECT, CHAT_THREAD_SUBJECT, threadKey } from "./origin.js";
import { messageMentions, messageRefs, workRefsOf } from "./refs.js";
import type { ChatOriginRecord } from "./types.js";

type Message = PayloadOf<"chat_message">;
type SessionStore = Pick<
  Store,
  "getSubject" | "upsertSubject" | "addItemRefs" | "getItem" | "updateItem" | "listItemRefs"
>;

const FINISHED = new Set(["done", "canceled"]);

/** The person's item the thread belongs to: the chat session that answered in it, or work filed or attached from it. */
async function threadItem(store: SessionStore, key: string, person: string) {
  const linked = (await store.getSubject(CHAT_THREAD_SUBJECT, key))?.data as
    | { itemId: string }
    | undefined;

  const item = linked ? await store.getItem(linked.itemId) : undefined;
  return item?.person === person ? item : undefined;
}

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
 * Makes a work item the pipeline queued for a chat message a chat session: the thread to answer in and the requester
 * (so the filing verbs and the reports work), and the message and the tickets it names as what woke it. A message in
 * the thread of work filed or attached from chat is about that work: the session is told which item it is and gets
 * its tickets and pull requests, and the thread stays with the work while it runs, so its result is posted there. A
 * session that answered in the thread before goes on with its conversation.
 */
export async function openChatSession(store: SessionStore, item: WorkItem, m: Message) {
  const thread = m.thread ?? m.messageId;
  const key = threadKey(m.channel, thread);
  const earlier = await threadItem(store, key, item.person);
  const work = earlier?.kind === CHAT_KIND ? undefined : earlier;
  const running = work !== undefined && !FINISHED.has(work.status);
  await store.upsertSubject(CHAT_ORIGIN_SUBJECT, item.id, originOf(m, thread, work, running));
  await goOn(store, item, earlier);
  if (!running) {
    await store.upsertSubject(CHAT_THREAD_SUBJECT, key, { itemId: item.id });
  }

  const about = work ? await workRefsOf(store, work.id, `chat_thread:${work.id}`) : [];
  await store.addItemRefs(item.id, [
    ...messageRefs(m, "trigger"),
    ...(await messageMentions(store, m)),
    ...about,
  ]);
}

/** A session in the thread of an earlier chat session goes on with that session's conversation. */
async function goOn(store: SessionStore, item: WorkItem, earlier: WorkItem | undefined) {
  if (earlier?.kind === CHAT_KIND && earlier.sessionId) {
    await store.updateItem(item.id, { sessionId: earlier.sessionId });
  }
}

/** A chat session's origin: where to answer, who asked, and the earlier work of the thread it is about. */
function originOf(
  m: Message,
  thread: string,
  work: WorkItem | undefined,
  running: boolean,
): ChatOriginRecord {
  const about = work && {
    id: work.id,
    title: work.title,
    state: running ? ("running" as const) : ("finished" as const),
  };

  return {
    channel: m.channel,
    thread,
    requester: { id: m.author.id, ...(m.author.name ? { name: m.author.name } : {}) },
    direct: m.direct,
    participant: m.participant,
    awaitingPlacement: false,
    claimed: [],
    text: m.text,
    ...(m.files?.length ? { files: m.files } : {}),
    ...(about ? { about } : {}),
  };
}

/** A later message of the conversation, folded into its session: its thread and the tickets it names. */
export async function joinChatSession(store: SessionStore, itemId: string, m: Message) {
  await store.addItemRefs(itemId, [
    ...messageRefs(m, "attached"),
    ...(await messageMentions(store, m)),
  ]);
}
