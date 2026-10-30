import { threadKey } from "./chat/origin.js";
import { chatEvent, withFiles } from "./chat/event.js";
import { appendChatLog } from "./chat/log.js";
import type { ChatEntryOptions } from "./office-chat.types.js";
import type { ChatDesk } from "./protocol/source.types.js";

/**
 * Where a chat message an agent passes on enters the office (decision 0016: chat is an event like any other): intake
 * records it as a `chat.message` and the pipeline decides on it. The agent hears only that it was received.
 */
export function createChatEntry(opts: ChatEntryOptions): Pick<ChatDesk, "message"> {
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
      return { repeated: !fresh };
    },
  };
}
