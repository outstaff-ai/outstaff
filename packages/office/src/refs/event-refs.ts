import type { PrRef } from "@outstaff/core";
import type { NewItemRef } from "#/store/types.js";
import type { EventSubject } from "./types.js";

/** The key of a chat thread: `<channel>:<thread>`. */
export const chatThreadRef = (channel: string, thread: string) => `${channel}:${thread}`;

/** The key of a chat conversation, as wakes and work items name a chat subject: `<channel>:<thread>`, or the channel. */
export const conversationRef = (c: { channel: string; thread?: string | undefined }) =>
  c.thread === undefined ? c.channel : chatThreadRef(c.channel, c.thread);

/** What woke an item: everything the event is about, each a `trigger` reference with the event as its source. */
export function triggerRefs(
  subject: EventSubject,
  source: string,
  prKey: (pr: PrRef) => string,
): NewItemRef[] {
  const { ticket, pr, doc, chat } = subject;
  const trigger = (type: NewItemRef["type"], ref: string): NewItemRef => ({
    type,
    ref,
    role: "trigger",
    source,
  });

  return [
    ...(pr ? [trigger("pr", prKey(pr))] : []),
    ...(ticket ? [trigger("ticket", ticket)] : []),
    ...(doc ? [trigger("doc", doc)] : []),
    ...(chat?.thread ? [trigger("chat_thread", chatThreadRef(chat.channel, chat.thread))] : []),
  ];
}
