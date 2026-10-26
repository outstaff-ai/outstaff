import { z } from "zod";

/** Bumped on any incompatible change to the messages below. Both sides must match exactly. */
export const PROTOCOL_VERSION = 1;

export const WORK_STATUSES = [
  "queued",
  "active",
  "waiting",
  "done",
  "blocked",
  "canceled",
] as const;

export const MEMBER_STATUSES = ["idle", "working", "paused", "offline"] as const;

export const ERROR_CODES = [
  "malformed",
  "unknown_type",
  "invalid_message",
  "unauthenticated",
  "auth_failed",
  "version_mismatch",
  "replaced",
  "unknown_item",
  "not_found",
  "invalid",
  "unsupported",
  "failed",
] as const;

const text = z.string().min(1).max(100_000);
const itemId = z.string().min(1).max(200).describe("Id of the work item.");

export const refSchema = z.strictObject({
  type: z.string().min(1).describe("Kind of subject, for example a ticket or a pull request."),
  ref: z.string().min(1).describe("Reference of the subject in its system."),
  title: z.string().optional().describe("Human-readable title."),
  url: z.string().optional().describe("Link to the subject."),
  headRef: z.string().optional().describe("For a pull request: the branch it is opened from."),
  baseRef: z.string().optional().describe("For a pull request: the branch it targets."),
  state: z
    .enum(["open", "closed", "merged"])
    .optional()
    .describe("For a pull request: whether it is open, closed or merged."),
  own: z
    .boolean()
    .optional()
    .describe("For a pull request: true when the person the item is offered to opened it."),
});

export const linkSchema = z.strictObject({
  url: z.string().min(1).describe("Absolute URL."),
  title: z.string().optional().describe("Label for the link."),
});

export const journalEntrySchema = z.strictObject({
  at: z.string().describe("ISO-8601 timestamp."),
  author: z.string().describe("Handle of the author."),
  text: z.string(),
});

/** Most files of one message the office keeps and the agent considers. */
export const MAX_CHAT_FILES = 10;

export const chatFileSchema = z.strictObject({
  id: z.string().min(1).max(200).describe("Id of the file in the chat workspace."),
  name: z.string().min(1).max(500).describe("File name, as the sender named it. Data from them."),
  mimetype: z.string().min(1).max(200),
  size: z.number().int().min(0).describe("Size in bytes."),
  url: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "Where the chat adapter fetches the bytes from. Only the agent's chat adapter uses it; the office stores it as it is and never fetches it.",
    ),
});

export const chatOriginSchema = z.strictObject({
  channel: z.string().min(1).describe("Chat channel of the request."),
  thread: z.string().min(1).describe("Thread the agent answers in."),
  requester: z.strictObject({
    id: z.string().min(1).describe("Id of the requester in the chat workspace."),
    name: z.string().optional(),
  }),
  direct: z.boolean().describe("The conversation is a direct message with the requester."),
  participant: z
    .boolean()
    .describe(
      "The requester started the thread or replied in it, so the chat already notifies them.",
    ),
  files: z
    .array(chatFileSchema)
    .max(MAX_CHAT_FILES)
    .optional()
    .describe(
      "Files shared in the message that started the chat session. Metadata only: the agent fetches the bytes from chat. Data from the requester.",
    ),
  about: z
    .strictObject({
      id: z.string().min(1),
      title: z.string(),
      state: z
        .enum(["running", "finished"])
        .describe("Whether the work is still running or was handed back, done or canceled."),
    })
    .optional()
    .describe(
      "For a chat session started by a reply in the thread of earlier work: that work item. Its ticket, pull request and journal are in the offer's context.",
    ),
});

export const workItemSchema = z.strictObject({
  id: z.string().min(1),
  kind: z
    .string()
    .describe("What the work is, for example a ticket, a review round or a question."),
  title: z.string(),
  priority: z.number().describe("Lower runs first."),
  trigger: z.enum(["human", "agent", "automation", "schedule"]),
  parentId: z.string().optional().describe("The item this one was split from, for questions."),
  subject: z.strictObject({ type: z.string(), ref: z.string() }).optional(),
  origin: chatOriginSchema
    .optional()
    .describe("Where the request came from, for items started by a chat message."),
});

export const inlineCommentSchema = z.strictObject({
  id: z.string().min(1).describe("The comment's id on the host."),
  path: z.string().min(1).describe("File the comment is on."),
  line: z.number().int().optional().describe("Line the comment is on."),
  body: z.string().describe("What the person wrote. Data from that person."),
  url: z.string().optional().describe("Link to the comment."),
  threadId: z
    .string()
    .optional()
    .describe("The review thread to reply in and resolve, when the host reports one."),
});

export const feedbackSchema = z.strictObject({
  actor: z.string().min(1).describe("Login of the person who gave the feedback."),
  kind: z
    .enum(["review", "comment", "inline_comment", "chat", "ticket_comment", "doc_comment"])
    .describe(
      "A review with its summary, a comment on the pull request conversation, an inline comment on the diff, a message from a trusted human in chat, a comment on a ticket, or a comment or reply on a knowledge document.",
    ),
  state: z.string().optional().describe("For a review: approved, changes_requested or commented."),
  url: z.string().optional().describe("Link to the feedback."),
  commentId: z
    .string()
    .optional()
    .describe(
      "For a comment or inline comment: its id on the host. The kind tells which kind of comment it is. For a ticket or document comment, its id in the tracker or knowledge base.",
    ),
  docId: z.string().optional().describe("For a document comment: the id of the document."),
  anchorText: z
    .string()
    .optional()
    .describe(
      "For a document comment: the text of the document it is anchored to. Data from the document.",
    ),
  at: z.string().optional().describe("When the host reported the feedback (ISO-8601)."),
  body: z.string().describe("What the person wrote. Data from that person."),
  comments: z
    .array(inlineCommentSchema)
    .optional()
    .describe("For a review: its inline comments, oldest first."),
});

export const conversationEntrySchema = z.strictObject({
  kind: z
    .enum(["comment", "review"])
    .describe("A comment on the pull request or a review summary."),
  author: z.string().min(1).describe("Login of the person who wrote it."),
  at: z.string().describe("When the host recorded it (ISO-8601)."),
  state: z.string().optional().describe("For a review: approved, changes_requested or commented."),
  url: z.string().optional().describe("Link to the entry."),
  body: z.string().describe("What the person wrote, trimmed. Data from that person."),
});

export const offerContextSchema = z.strictObject({
  journal: z.array(journalEntrySchema).describe("What earlier rounds of this item recorded."),
  subjects: z.array(refSchema).describe("The tickets, pull requests and people the item concerns."),
  links: z.array(linkSchema).describe("Further links worth opening."),
  feedback: z
    .array(feedbackSchema)
    .optional()
    .describe(
      "For a review round: the reviews and comments it covers, oldest first. Feedback that arrives while the item is queued is added; what arrives while it runs starts a follow-up round.",
    ),
  conversation: z
    .array(conversationEntrySchema)
    .optional()
    .describe(
      "For a round started by a comment on the pull request conversation or a review summary: the few entries of the conversation before the first of them, oldest first, so a short reply has its context.",
    ),
});

export const workSummarySchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  kind: z
    .string()
    .optional()
    .describe("What the item is, for example assigned or review_feedback."),
  ticketKey: z.string().optional(),
  ticketTitle: z.string().optional(),
  pr: z.string().optional().describe("The office's key of the pull request the item is about."),
  prNumber: z.number().int().optional(),
  prTitle: z.string().optional(),
  prUrl: z.string().optional(),
  current: z.boolean().optional().describe("True for the item the caller asked about."),
});

/** What the office did with work a chat session filed: a ticket or a request, and where the work stands. */
export const filedSchema = z.strictObject({
  url: z.string().optional().describe("Link to the ticket."),
  item: workSummarySchema.describe("The work item that carries the filed work."),
  waiting: z
    .boolean()
    .describe(
      "True when the person is busy: the item waits at the end until the requester says where it goes. False when it starts now.",
    ),
  work: z
    .array(workSummarySchema)
    .describe("The person's other open items in the order they run, for the placement question."),
});

export const usageWindowSchema = z.strictObject({
  name: z.string().min(1).max(50).describe("Which limit, for example five_hour or seven_day."),
  utilization: z.number().min(0).describe("Fraction of the limit used; 1 is the limit."),
  resetsAt: z.string().optional().describe("ISO-8601 time at which the window resets."),
});

export const memberUsageSchema = z.strictObject({
  window: z.string().describe("The busiest window."),
  utilization: z.number().describe("Fraction of that window's limit used."),
  resetsAt: z.string().optional().describe("ISO-8601 time at which that window resets."),
});

export const memberSchema = z.strictObject({
  handle: z.string(),
  name: z.string(),
  role: z.string(),
  title: z.string().optional().describe("Display title of the role, for example Developer."),
  summary: z.string().optional().describe("One line on what the role does."),
  status: z.enum(MEMBER_STATUSES),
  current: z.string().optional().describe("What the person is working on."),
  usage: memberUsageSchema
    .optional()
    .describe("The person's busiest LLM usage window, when it was reported recently."),
});

export const humanSchema = z.strictObject({
  name: z.string(),
});

export const answerStateSchema = z.strictObject({
  id: z.string().describe("Id of the question."),
  to: z.string(),
  status: z.enum(["answered", "pending"]),
  answer: z.string().optional(),
});

const empty = z.strictObject({});

function message<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({
    id: z.string().min(1).max(200).describe("Unique id of this message."),
    replyTo: z.string().min(1).max(200).optional().describe("Id of the request this answers."),
    type: z.literal(type),
    payload,
  });
}

export const messageSchema = z.discriminatedUnion("type", [
  message(
    "hello",
    z.strictObject({
      person: z.string().min(1).max(30).describe("Handle of the person this agent runs as."),
      token: z.string().min(1).max(500).describe("The person's agent token."),
      protocolVersion: z.number().int().describe("PROTOCOL_VERSION the agent speaks."),
      agentVersion: z.string().max(100).describe("Version of the agent software."),
    }),
  ),
  message(
    "welcome",
    z.strictObject({
      protocolVersion: z.number().int().describe("PROTOCOL_VERSION the office speaks."),
      heartbeatMs: z.number().int().positive().describe("Send a heartbeat at least this often."),
      resume: z
        .array(z.string())
        .describe("Ids of accepted, unfinished items the agent should carry on with."),
    }),
  ),
  message(
    "offer",
    z.strictObject({
      workItem: workItemSchema.describe("The item to work on."),
      context: offerContextSchema.describe("What the agent needs to start."),
      sessionId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Runtime session of this item from an earlier round; resume it when present."),
      interrupted: z
        .boolean()
        .optional()
        .describe(
          "True when the item's previous run was cut short by an agent shutdown; the prompt says so.",
        ),
    }),
  ),
  message("accept", z.strictObject({ workItemId: itemId })),
  message(
    "decline",
    z.strictObject({
      workItemId: itemId,
      reason: text.describe("Why the agent cannot take it now."),
    }),
  ),
  message(
    "heartbeat",
    z.strictObject({ workItemId: itemId.optional().describe("The item being worked on, if any.") }),
  ),
  message("progress", z.strictObject({ workItemId: itemId, text: text })),
  message(
    "session",
    z.strictObject({
      workItemId: itemId,
      sessionId: z.string().min(1).max(200).describe("Id of the runtime session working the item."),
    }),
  ),
  message(
    "usage",
    z.strictObject({
      windows: z
        .array(usageWindowSchema)
        .max(20)
        .describe("The runtime's current LLM usage windows; replaces the earlier report."),
    }),
  ),
  message("journal", z.strictObject({ workItemId: itemId, text: text })),
  message(
    "handback",
    z.strictObject({
      workItemId: itemId,
      summary: text.describe("What was done, decisions and open points."),
      links: z.array(linkSchema).describe("Pull requests, documents and tickets touched."),
      status: z
        .enum(["done", "waiting", "blocked", "interrupted"])
        .describe(
          "Whether the item is finished, waits for something, is stuck, or was cut short by the agent shutting down. An interrupted item goes back to the front of the queue and is offered again with its session.",
        ),
    }),
  ),
  message("fail", z.strictObject({ workItemId: itemId, reason: text })),
  message(
    "ask",
    z.strictObject({
      to: z.string().min(1).max(30),
      question: text,
      workItemId: itemId.optional().describe("The asker's current item."),
    }),
  ),
  message("ask_result", answerStateSchema),
  message("answer", z.strictObject({ questionId: z.string().min(1), answer: text })),
  message("roster", empty),
  message(
    "roster_result",
    z.strictObject({
      members: z.array(memberSchema),
      humans: z.array(humanSchema).optional().describe("The trusted humans of the team."),
    }),
  ),
  message("work_list", z.strictObject({ workItemId: itemId.optional() })),
  message("work_list_result", z.strictObject({ items: z.array(workSummarySchema) })),
  message(
    "work_move",
    z.strictObject({
      workItemId: itemId,
      status: z.enum(["queued", "blocked", "canceled"]).describe("The new status."),
    }),
  ),
  message("work_move_result", z.strictObject({ item: workSummarySchema })),
  message(
    "work_place",
    z.strictObject({
      workItemId: itemId,
      position: z
        .enum(["next", "last", "before", "after"])
        .describe("Where among the queued items it goes."),
      relativeTo: itemId
        .optional()
        .describe("The queued item to go before or after; required for `before` and `after`."),
    }),
  ),
  message(
    "work_link",
    z.strictObject({
      workItemId: itemId,
      ticket: z.string().min(1).max(200).describe("Key of the ticket the agent created."),
    }),
  ),
  message("work_link_result", filedSchema),
  message(
    "work_queue",
    z.strictObject({
      workItemId: itemId,
      title: z.string().min(1).max(300).describe("Short title of the work."),
      body: z.string().max(20_000).default("").describe("What is asked and why."),
    }),
  ),
  message("work_queue_result", filedSchema),
  message(
    "work_attach",
    z.strictObject({
      workItemId: itemId,
      target: z
        .string()
        .min(1)
        .max(500)
        .describe(
          "A ticket key, or a pull request: its number, `#number`, `owner/repo#number` or link.",
        ),
      confirmed: z
        .boolean()
        .default(false)
        .describe(
          "True when the requester said in the thread that the request belongs to a pull request that is in review.",
        ),
      request: z
        .string()
        .max(20_000)
        .optional()
        .describe(
          "What to add, when the session's message is only the requester's answer and the request came earlier in the thread. Default: the session's message.",
        ),
    }),
  ),
  message(
    "work_attach_result",
    filedSchema.extend({
      attached: z
        .strictObject({
          ticket: refSchema.optional().describe("The ticket the request was added to."),
          pr: refSchema.optional().describe("The pull request the request was added to."),
        })
        .describe("The existing work the request is part of now."),
    }),
  ),
  message(
    "chat_message",
    z.strictObject({
      messageId: z.string().min(1).max(200).describe("Id of the message in the chat workspace."),
      channel: z.string().min(1).max(200),
      thread: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Thread of the message; absent for a top-level message."),
      text: z
        .string()
        .max(100_000)
        .describe("What the author wrote; empty for a message that only shares files."),
      author: z.strictObject({
        id: z.string().min(1).max(200),
        name: z.string().max(200).optional(),
      }),
      direct: z.boolean().describe("The message is in a direct message with the author."),
      participant: z.boolean().describe("The author started the thread or replied in it."),
      files: z
        .array(chatFileSchema)
        .max(MAX_CHAT_FILES)
        .optional()
        .describe("Files shared in the message: metadata only, no bytes. Data from the author."),
    }),
  ),
  message(
    "chat_message_result",
    z.strictObject({
      disposition: z
        .enum(["started", "limited", "joined", "placed", "asked_pm", "unclear"])
        .describe(
          "What the office did: `started` a chat session for the message, or held it as `limited` until a chat session is free, `joined` an item of the thread, `placed` the item waiting for its place, `asked_pm` to prioritize it, or could not read the answer (`unclear`).",
        ),
      repeated: z.boolean().describe("True when the office already handled this message."),
      item: workSummarySchema.describe("The item the message belongs to."),
      links: z
        .array(linkSchema)
        .describe("What the office created for the request, for example the ticket."),
      work: z
        .array(workSummarySchema)
        .describe("The person's other open items in the order they run, for `unclear`."),
      placement: z.string().optional().describe("For `placed`: where the item goes, in words."),
    }),
  ),
  message(
    "chat_report",
    z.strictObject({
      workItemId: itemId,
      kind: z
        .enum(["ack", "result", "blocked", "failed"])
        .describe("What the agent is about to tell the requester."),
    }),
  ),
  message(
    "chat_report_result",
    z.strictObject({
      post: z
        .boolean()
        .describe("False when nothing should be posted: no chat origin, or already reported."),
      requester: z.string().optional().describe("Id of the requester to mention."),
      links: z.array(linkSchema).describe("The ticket and pull requests of the item."),
      threads: z
        .array(chatOriginSchema.omit({ about: true, files: true }))
        .optional()
        .describe(
          "Every thread linked to the item now, to post the result in: the one it came from and the ones attached later. Absent when nothing should be posted.",
        ),
    }),
  ),
  message(
    "doc_link",
    z.strictObject({
      workItemId: itemId,
      doc: z.strictObject({
        id: z.string().min(1).max(500).describe("Id of the document in the knowledge base."),
        title: z.string().max(500).describe("Title of the document."),
        url: z.string().min(1).describe("Absolute URL of the document."),
      }),
    }),
  ),
  message("current_work", empty),
  message("current_work_result", z.strictObject({ text: z.string() })),
  message(
    "ticket_prs",
    z.strictObject({
      headRef: z.string().min(1).max(250).describe("Branch the pull request would be opened from."),
      title: z.string().min(1).max(256).describe("Title it would have."),
      body: z.string().max(65_000).describe("Description it would have."),
    }),
  ),
  message(
    "ticket_prs_result",
    z.strictObject({
      ticket: z
        .string()
        .optional()
        .describe(
          "The ticket the pull request would link to, by the rule that links existing ones (branch, then title, then a closing keyword in the body; a bare mention links nothing); absent when it would link to none.",
        ),
      prs: z
        .array(
          z.strictObject({
            ref: z.string().describe("Pull request, for example `acme/shop#12`."),
            number: z.number().int(),
            title: z.string(),
            url: z.string().optional(),
            state: z.enum(["open", "closed", "merged"]),
            authorKind: z.enum(["human", "agent", "bot"]),
          }),
        )
        .describe("The pull requests already linked to that ticket, in any state."),
    }),
  ),
  message("ack", empty),
  message(
    "error",
    z.strictObject({
      code: z.enum(ERROR_CODES),
      message: z.string(),
    }),
  ),
  message("ping", empty),
  message("pong", empty),
]);

export type Message = z.infer<typeof messageSchema>;
export type MessageType = Message["type"];
export type MessageOf<T extends MessageType> = Extract<Message, { type: T }>;
export type PayloadOf<T extends MessageType> = MessageOf<T>["payload"];
export type ErrorCode = (typeof ERROR_CODES)[number];

export type Ref = z.infer<typeof refSchema>;
export type Link = z.infer<typeof linkSchema>;
export type JournalLine = z.infer<typeof journalEntrySchema>;
export type OfferedWorkItem = z.infer<typeof workItemSchema>;
export type InlineComment = z.infer<typeof inlineCommentSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type ConversationEntry = z.infer<typeof conversationEntrySchema>;
export type OfferContext = z.infer<typeof offerContextSchema>;
export type WorkSummary = z.infer<typeof workSummarySchema>;
export type Filed = z.infer<typeof filedSchema>;
export type Attached = PayloadOf<"work_attach_result">;
export type UsageWindowReport = z.infer<typeof usageWindowSchema>;
export type MemberUsage = z.infer<typeof memberUsageSchema>;
export type ChatOrigin = z.infer<typeof chatOriginSchema>;
export type ChatFile = z.infer<typeof chatFileSchema>;
export type Human = z.infer<typeof humanSchema>;
export type Member = z.infer<typeof memberSchema>;
export type AnswerState = z.infer<typeof answerStateSchema>;
