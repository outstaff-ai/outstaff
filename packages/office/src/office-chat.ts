import { threadKey } from "./chat/origin.js";
import { chatEvent, withFiles } from "./chat/event.js";
import { appendChatLog } from "./chat/log.js";
import type { ChatEntryOptions } from "./office-chat.types.js";
import type { ChatDesk } from "./protocol/source.types.js";

/** How many of a person's conversations the agent catches up on: the latest ones. */
export const CHAT_CURSORS_KEPT = 100;

/**
 * Where a chat message an agent passes on enters the office (decision 0016: chat is an event like any other): intake
 * records it as a `chat.message` and the pipeline decides on it. The agent hears only that it was received. Each
 * message moves its conversation's cursor, which the agent catches up from when its chat connects again.
 */
export function createChatEntry(opts: ChatEntryOptions): Pick<ChatDesk, "message" | "cursors"> {
  const { intake, store, clock } = opts;
  return {
    async message(person, m) {
      const at = clock.now().toISOString();
      const { event, meta } = chatEvent(person, m, at);
      // The thread's log is what a wake's context hands over of the conversation.
      await appendChatLog(store, threadKey(m.channel, m.thread ?? m.messageId), {
        messageId: m.messageId,
        author: m.author,
        at,
        text: withFiles(m),
      });

      const fresh = await intake.receive(event, meta);
      // A message taken in already moves nothing, but a cursor lost to a crash after intake is put right.
      await store.advanceChatCursor(person, { channel: m.channel, thread: m.thread, at: m.at });
      return { repeated: !fresh };
    },

    async cursors(person) {
      return { cursors: await store.listChatCursors(person, CHAT_CURSORS_KEPT) };
    },
  };
}
