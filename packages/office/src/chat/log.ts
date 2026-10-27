import type { Store } from "#/store/types.js";
import type { ChatLogEntry } from "./types.js";

/** The messages of a chat thread the office received, keyed by `<channel>:<thread>`, oldest first. */
export const CHAT_LOG_SUBJECT = "chat_log";

/** How many messages a thread keeps; the oldest go first. */
export const CHAT_LOG_KEEP = 50;

export async function readChatLog(
  store: Pick<Store, "getSubject">,
  thread: string,
): Promise<ChatLogEntry[]> {
  return (
    ((await store.getSubject(CHAT_LOG_SUBJECT, thread))?.data as ChatLogEntry[] | undefined) ?? []
  );
}

/** Adds a message to its thread's log; a message already there is not added twice. */
export async function appendChatLog(
  store: Pick<Store, "getSubject" | "upsertSubject">,
  thread: string,
  entry: ChatLogEntry,
): Promise<void> {
  const log = await readChatLog(store, thread);
  if (log.some((e) => e.messageId === entry.messageId)) {
    return;
  }

  await store.upsertSubject(CHAT_LOG_SUBJECT, thread, [...log, entry].slice(-CHAT_LOG_KEEP));
}
