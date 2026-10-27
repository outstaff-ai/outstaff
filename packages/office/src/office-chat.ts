import { threadKey } from "./chat/origin.js";
import { chatEvent, withFiles } from "./chat/event.js";
import { appendChatLog } from "./chat/log.js";
import { conversationRef } from "./refs/index.js";
import { deskRecord } from "./pipeline/compare/desk.js";
import type { ChatEntryOptions } from "./office-chat.types.js";
import type { ChatDesk } from "./protocol/source.types.js";

type Message = Parameters<ChatDesk["message"]>[1];
type MessageResult = Awaited<ReturnType<ChatDesk["message"]>>;

/**
 * Where a chat message an agent passes on enters the office (decision 0016: chat is an event like any other). Off, the
 * chat desk routes it, as before. In shadow mode the desk still routes it, and the message is also recorded by intake
 * as a `chat.message` carrying what the desk did, so its trace compares the two. Live, intake records it and the
 * pipeline decides; the agent hears only that it was received.
 */
export function createChatEntry(opts: ChatEntryOptions): Pick<ChatDesk, "message"> {
  const { mode, desk, intake, store, clock, logger } = opts;

  async function shadow(person: string, m: Message, result: MessageResult) {
    const { event, meta } = chatEvent(person, m, clock.now().toISOString());
    const subject = { type: "chat" as const, ref: conversationRef(event.subject.chat!) };
    try {
      const data = { ...event.data, desk: deskRecord(person, subject, result) };
      await intake.receive({ ...event, data }, meta);
    } catch (error) {
      logger.warn("pipeline (shadow) could not record a chat message", {
        id: meta.externalId,
        error: String(error),
      });
    }
  }

  async function live(person: string, m: Message): Promise<MessageResult> {
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
    return { disposition: "received", repeated: !fresh, links: [], work: [] };
  }

  return {
    async message(person, m) {
      if (mode === "live") {
        return live(person, m);
      }

      const result = await desk.message(person, m);
      if (mode === "shadow" && !result.repeated) {
        await shadow(person, m, result);
      }

      return result;
    },
  };
}
