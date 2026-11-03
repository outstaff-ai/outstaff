import type { MessageMeta, MessageType } from "./types.js";

/** The messages about work items: listing, status, placing, filing from chat, and what an agent made in one. */
export const WORK_MESSAGE_META = {
  work_made: {
    from: "agent",
    summary:
      "Tells the office what the caller made in a work item: a ticket it created, or a pull request it opened and the ticket that pull request links to. The office records them on the item, so the item's hand-back also gives those tickets, once in review, to the person who asked.",
    replies: ["ack", "error"],
  },
  work_list: {
    from: "agent",
    summary: "Asks for the caller's work items.",
    replies: ["work_list_result", "error"],
  },
  work_list_result: { from: "office", summary: "The caller's work items.", replies: [] },
  work_status: {
    from: "agent",
    summary:
      "Asks for the state of a list of work items, for example to find the ones whose worktree and scratch folder can go.",
    replies: ["work_status_result", "error"],
  },
  work_status_result: {
    from: "office",
    summary:
      "The state of each item asked about, in the order asked. An item of someone else is `not_yours` and an item the office does not have is `unknown`; nothing else about either is given.",
    replies: [],
  },
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
      "Files the ticket a chat session created as work: the office creates a work item for it, in the thread the session answers in. Refused for an item that is not a chat session.",
    replies: ["work_link_result", "error"],
  },
  work_file_for: {
    from: "agent",
    summary:
      "Records the ticket a chat session created for someone else against the chat request: no work item is created, and the session's own work is not tied to the ticket. The assignee is woken by the assignment, like any other. Refused like `work_link`.",
    replies: ["ack", "error"],
  },
  work_check: {
    from: "agent",
    summary:
      "Asks whether a chat session may file a request now, before it creates the ticket. Refused for an item that is not a chat session and for a request the message already filed, so a refused filing leaves nothing in the tracker.",
    replies: ["ack", "error"],
  },
  work_link_result: {
    from: "office",
    summary: "The work item created for the ticket, and whether it waits for its place.",
    replies: [],
  },
  work_queue: {
    from: "agent",
    summary:
      "Files work from a chat session when there is no tracker: the office creates a work item for it, in the thread the session answers in. Refused for an item that is not a chat session.",
    replies: ["work_queue_result", "error"],
  },
  work_queue_result: {
    from: "office",
    summary: "The work item created for the request, and whether it waits for its place.",
    replies: [],
  },
  work_attach: {
    from: "agent",
    summary:
      "Makes a chat session's request part of existing work of the caller (a ticket or a pull request) instead of new work: the request becomes a round on it, carrying the human's message as feedback, and the thread belongs to that item. Refused for work that is not the caller's, for merged or done work, and for a pull request in review unless the requester confirmed.",
    replies: ["work_attach_result", "error"],
  },
  work_attach_result: {
    from: "office",
    summary: "The existing work the request is part of now.",
    replies: [],
  },
} as const satisfies Partial<Record<MessageType, MessageMeta>>;
