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
});

export const offerContextSchema = z.strictObject({
  journal: z.array(journalEntrySchema).describe("What earlier rounds of this item recorded."),
  subjects: z.array(refSchema).describe("The tickets, pull requests and people the item concerns."),
  links: z.array(linkSchema).describe("Further links worth opening."),
});

export const workSummarySchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  ticketKey: z.string().optional(),
  prUrl: z.string().optional(),
  current: z.boolean().optional().describe("True for the item the caller asked about."),
});

export const memberSchema = z.strictObject({
  handle: z.string(),
  name: z.string(),
  role: z.string(),
  title: z.string().optional().describe("Display title of the role, for example Developer."),
  summary: z.string().optional().describe("One line on what the role does."),
  status: z.enum(MEMBER_STATUSES),
  current: z.string().optional().describe("What the person is working on."),
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
  message("journal", z.strictObject({ workItemId: itemId, text: text })),
  message(
    "handback",
    z.strictObject({
      workItemId: itemId,
      summary: text.describe("What was done, decisions and open points."),
      links: z.array(linkSchema).describe("Pull requests, documents and tickets touched."),
      status: z
        .enum(["done", "waiting", "blocked"])
        .describe("Whether the item is finished, waits for something, or is stuck."),
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
export type OfferContext = z.infer<typeof offerContextSchema>;
export type WorkSummary = z.infer<typeof workSummarySchema>;
export type Human = z.infer<typeof humanSchema>;
export type Member = z.infer<typeof memberSchema>;
export type AnswerState = z.infer<typeof answerStateSchema>;
