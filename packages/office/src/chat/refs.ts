import { chatThreadRef, mentionedRefs } from "#/refs/index.js";
import type { ItemRefRole, NewItemRef, Store } from "#/store/types.js";

interface ChatMessageRef {
  channel: string;
  messageId: string;
  thread?: string | undefined;
  text: string;
}

/** The source of what a chat message added: the message itself. */
export const messageSource = (m: Pick<ChatMessageRef, "channel" | "messageId">) =>
  `chat:${m.channel}:${m.messageId}`;

/** A chat message's thread and the message itself, in the role the message plays for the item. */
export function messageRefs(m: ChatMessageRef, role: ItemRefRole): NewItemRef[] {
  const source = messageSource(m);
  return [
    { type: "chat_thread", ref: chatThreadRef(m.channel, m.thread ?? m.messageId), role, source },
    { type: "chat_message", ref: chatThreadRef(m.channel, m.messageId), role, source },
  ];
}

/** The tickets a chat message names that the office knows. */
export function messageMentions(
  store: Pick<Store, "getSubject">,
  m: ChatMessageRef,
): Promise<NewItemRef[]> {
  return mentionedRefs(
    m.text,
    messageSource(m),
    async (key) => (await store.getSubject("ticket", key)) !== undefined,
  );
}

/**
 * The chat references of one item recorded again on another, in a new role: the thread a chat session filed work
 * from becomes the trigger of the filed work.
 */
export async function chatRefsOf(
  store: Pick<Store, "listItemRefs">,
  itemId: string,
  role: ItemRefRole,
  source: string,
): Promise<NewItemRef[]> {
  return (await store.listItemRefs(itemId))
    .filter((r) => r.type === "chat_thread" || r.type === "chat_message")
    .map((r) => ({ type: r.type, ref: r.ref, role, source }));
}

/** The tickets, pull requests and documents of an item, for a chat session about that item's work. */
export async function workRefsOf(
  store: Pick<Store, "listItemRefs">,
  itemId: string,
  source: string,
): Promise<NewItemRef[]> {
  return (await store.listItemRefs(itemId))
    .filter((r) => r.type === "ticket" || r.type === "pr" || r.type === "doc")
    .map((r) => ({ type: r.type, ref: r.ref, url: r.url, role: "inferred", source }));
}
