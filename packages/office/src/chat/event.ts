import type { WorkflowEvent } from "@outstaff/core";
import type { PayloadOf } from "@outstaff/protocol";

type Message = PayloadOf<"chat_message">;

/** The source of the office's chat events, as intake records them. */
export const CHAT_SOURCE = "chat";

/** The message's text with a line naming its files, for the journal. The files are data from the author. */
export const withFiles = (m: Pick<Message, "text" | "files">) =>
  m.files?.length
    ? `${m.text}\n(Shared ${m.files.map((f) => `${f.name} (${f.mimetype})`).join(", ")}.)`.trimStart()
    : m.text;

/**
 * The conversation a message belongs to: its thread, or a top-level message's own thread, except in a direct message,
 * where top-level messages are one conversation, so quick follow-ups wake one run.
 */
export function chatConversation(m: Pick<Message, "channel" | "thread" | "messageId" | "direct">) {
  const thread = m.thread ?? (m.direct ? undefined : m.messageId);
  return thread === undefined ? { channel: m.channel } : { channel: m.channel, thread };
}

/** The intake id of a message written to an agent: the same message to two agents is two events. */
export const chatEventId = (person: string, m: Pick<Message, "channel" | "messageId">) =>
  `${person}:${m.channel}:${m.messageId}`;

/**
 * A chat message to an agent as an office event (`chat.message`): written by a human (the agent passes on only trusted
 * humans' messages), addressed to the agent, about the conversation it belongs to. `data.message` keeps what the
 * office needs to open a chat session for it.
 */
export function chatEvent(
  person: string,
  m: Message,
  at: string,
): { event: WorkflowEvent; meta: { source: "chat"; externalId: string; trusted: true } } {
  return {
    event: {
      type: "chat.message",
      subject: { chat: chatConversation(m) },
      actor: { kind: "human", id: m.author.id },
      data: { body: withFiles(m), addressed: person, at, message: m },
    },
    meta: { source: CHAT_SOURCE, externalId: chatEventId(person, m), trusted: true },
  };
}
