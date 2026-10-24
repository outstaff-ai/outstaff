import type { MessageType } from "./schemas.js";

export interface MessageMeta {
  /** Who sends it. */
  from: "agent" | "office" | "both";
  summary: string;

  /** Message types that may answer it; empty for messages that are not requests. */
  replies: MessageType[];
}

export const MESSAGE_META = {
  hello: {
    from: "agent",
    summary:
      "First message on every connection. Authenticates the person and checks the protocol version.",
    replies: ["welcome", "error"],
  },
  welcome: {
    from: "office",
    summary: "The connection is accepted. Lists accepted items to resume.",
    replies: [],
  },
  offer: {
    from: "office",
    summary:
      "A work item for the agent to take, with its context. Delivered at least once: an offer that was not accepted is sent again after a reconnect, so handle the same id twice.",
    replies: [],
  },
  accept: {
    from: "agent",
    summary: "Takes an offered item. Accepting twice is harmless.",
    replies: ["ack", "error"],
  },
  decline: {
    from: "agent",
    summary: "Gives an offered item back to the queue.",
    replies: ["ack", "error"],
  },
  heartbeat: {
    from: "agent",
    summary: "Shows the agent is alive and, optionally, still working on an item.",
    replies: ["ack", "error"],
  },
  progress: {
    from: "agent",
    summary: "A short status line about the item, shown to people.",
    replies: ["ack", "error"],
  },
  session: {
    from: "agent",
    summary:
      "Stores the runtime session of an item, so a later round of the item resumes it. One session per item; sessions are never shared between items.",
    replies: ["ack", "error"],
  },
  usage: {
    from: "agent",
    summary:
      "Reports the LLM usage windows the runtime sees. The office keeps the latest report per person (and for people who share a subscription) and uses it for the usage policy.",
    replies: ["ack", "error"],
  },
  journal: {
    from: "agent",
    summary: "Appends a line to the item's journal, which later rounds start from.",
    replies: ["ack", "error"],
  },
  handback: {
    from: "agent",
    summary: "Finishes a round of the item with a summary.",
    replies: ["ack", "error"],
  },
  fail: {
    from: "agent",
    summary: "Reports that the agent could not do the item.",
    replies: ["ack", "error"],
  },
  ask: {
    from: "agent",
    summary: "Asks a teammate a question. The office routes it and may answer later.",
    replies: ["ask_result", "error"],
  },
  ask_result: {
    from: "office",
    summary: "The state of a question: answered, or still pending.",
    replies: [],
  },
  answer: {
    from: "agent",
    summary: "Answers a question that was offered as a work item.",
    replies: ["ack", "error"],
  },
  roster: {
    from: "agent",
    summary: "Asks for the team and what everyone is doing.",
    replies: ["roster_result", "error"],
  },
  roster_result: { from: "office", summary: "The team.", replies: [] },
  work_list: {
    from: "agent",
    summary: "Asks for the caller's work items.",
    replies: ["work_list_result", "error"],
  },
  work_list_result: { from: "office", summary: "The caller's work items.", replies: [] },
  work_move: {
    from: "agent",
    summary: "Changes the status of one of the caller's work items.",
    replies: ["work_move_result", "error"],
  },
  work_move_result: { from: "office", summary: "The item after the move.", replies: [] },
  work_place: {
    from: "agent",
    summary: "Moves one of the caller's queued items to a place in the queue.",
    replies: ["work_move_result", "error"],
  },
  work_link: {
    from: "agent",
    summary:
      "Makes a ticket the subject of a chat request's work item, after the agent created the ticket for it. Refused for an item that already has a ticket or pull request as its subject.",
    replies: ["work_link_result", "error"],
  },
  work_link_result: { from: "office", summary: "The ticket is linked to the item.", replies: [] },
  chat_message: {
    from: "agent",
    summary:
      "A message from a trusted human in chat. The office starts an item for it, queues it when the person is busy, or adds it to the item of the thread. Delivered at least once; the office recognizes a message it handled.",
    replies: ["chat_message_result", "error"],
  },
  chat_message_result: {
    from: "office",
    summary: "What the office did with the message, and what the agent should answer.",
    replies: [],
  },
  chat_report: {
    from: "agent",
    summary:
      "Asks to tell the requester of a chat item how it ended. The office grants it once per ending, so a retried hand-back does not post twice.",
    replies: ["chat_report_result", "error"],
  },
  chat_report_result: {
    from: "office",
    summary: "Whether to post, whom to mention and which links to include.",
    replies: [],
  },
  current_work: {
    from: "agent",
    summary: "Asks for the caller's open tickets and pull requests, as context for a chat session.",
    replies: ["current_work_result", "error"],
  },
  current_work_result: {
    from: "office",
    summary: "The caller's current work as text.",
    replies: [],
  },
  ack: { from: "office", summary: "The request succeeded and has nothing to return.", replies: [] },
  error: {
    from: "both",
    summary:
      "A request failed, or a message was malformed or not understood. Never closes the connection by itself, except for authentication and version errors.",
    replies: [],
  },
  ping: { from: "both", summary: "Liveness check.", replies: ["pong"] },
  pong: { from: "both", summary: "Answers a ping.", replies: [] },
} as const satisfies Record<MessageType, MessageMeta>;
