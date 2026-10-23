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
