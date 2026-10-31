import type { MessageMeta, MessageType } from "./types.js";

export const MESSAGE_META = {
  hello: {
    from: "agent",
    summary:
      "First message on every connection. Authenticates the person and checks the protocol version.",
    replies: ["welcome", "error"],
  },
  welcome: {
    from: "office",
    summary:
      "The connection is accepted. Carries the team config the agent works from, and lists accepted items to resume, the reports to requesters the agent was offline for and the acts it has not answered; the agent posts and makes those itself and confirms each.",
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
  chat_message: {
    from: "agent",
    summary:
      "A message from a trusted human in chat. The office takes it in as a `chat.message` event, which its pipeline decides on (by default it wakes the person in a chat session). Delivered at least once; the office recognizes a message it took in already.",
    replies: ["chat_message_result", "error"],
  },
  chat_message_result: {
    from: "office",
    summary:
      "The office took the message in; the agent answers nothing until the work it starts does.",
    replies: [],
  },
  chat_report: {
    from: "agent",
    summary:
      "Asks to tell the requester how an item ended: a chat item's result or blocked report in its thread, and for a blocked item the blocked report to the requester's direct message. The office grants it once per ending, so a retried hand-back does not post twice, and never posts anything itself.",
    replies: ["chat_report_result", "error"],
  },
  chat_report_result: {
    from: "office",
    summary: "Whether to post, whom to mention and which links to include.",
    replies: [],
  },
  reports: {
    from: "office",
    summary:
      "Reports to requesters for the agent to post as itself, sent while it is connected (the same list the `welcome` carries on connecting). Sent again until the agent confirms each with `report_posted`.",
    replies: [],
  },
  report_posted: {
    from: "agent",
    summary:
      "Confirms the agent posted a queued report. Only then does the office stop sending it, so a crash while posting sends it again.",
    replies: ["ack", "error"],
  },
  act: {
    from: "office",
    summary:
      "Tracker or knowledge-base changes the event pipeline decided for the agent (an `act` decision): moves, assignments, comments, parents and pull request links. The agent makes them with its own tracker and knowledge credentials, in order, without a model run, and answers with `act_result`. Sent while the agent is connected; the `welcome` carries the ones it has not answered.",
    replies: [],
  },
  act_result: {
    from: "agent",
    summary:
      "What the agent's changes for an act did. Only then does the office stop sending the act; it records the result on the event's trace and reads the tickets changed again, so later decisions see the change.",
    replies: ["ack", "error"],
  },
  doc_link: {
    from: "agent",
    summary:
      "Tells the office that the caller wrote a document for the ticket of a work item, so comments people leave on the document reach the caller as work.",
    replies: ["ack", "error"],
  },
  doctor_report: {
    from: "agent",
    summary:
      "Reports the checks only the agent's own container can make, run once at start: its declared tools installed, its granted services and devices answer, and its home volume has room. The office stores them with its own checks.",
    replies: ["ack", "error"],
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
  ticket_prs: {
    from: "agent",
    summary:
      "Asks which ticket a pull request about to be opened would link to and which pull requests that ticket already has, so `ost pr open` can keep to one pull request per ticket.",
    replies: ["ticket_prs_result", "error"],
  },
  ticket_prs_result: {
    from: "office",
    summary: "The ticket the pull request would link to, and the pull requests it already has.",
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
