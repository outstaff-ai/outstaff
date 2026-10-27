import type { z } from "zod";
import type { ERROR_CODES } from "./constants.js";
import type {
  chatFileSchema,
  chatOriginSchema,
  journalEntrySchema,
  linkSchema,
  refSchema,
  workItemSchema,
} from "./schemas/common.js";
import type {
  conversationEntrySchema,
  feedbackSchema,
  inlineCommentSchema,
  offerContextSchema,
} from "./schemas/feedback.js";
import type {
  contextChatSchema,
  contextDocSchema,
  contextNoteSchema,
  contextPrSchema,
  contextTicketSchema,
  contextWhySchema,
  wakeContextSchema,
} from "./schemas/context.js";
import type { doctorCheckSchema } from "./schemas/doctor.js";
import type { messageSchema } from "./schemas/message.js";
import type {
  answerStateSchema,
  humanSchema,
  memberSchema,
  memberUsageSchema,
  usageWindowSchema,
} from "./schemas/team.js";
import type {
  filedSchema,
  queuedReportSchema,
  workStateSchema,
  workSummarySchema,
} from "./schemas/work.js";

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
export type WakeContext = z.infer<typeof wakeContextSchema>;
export type ContextWhy = z.infer<typeof contextWhySchema>;
export type ContextNote = z.infer<typeof contextNoteSchema>;
export type ContextTicket = z.infer<typeof contextTicketSchema>;
export type ContextPr = z.infer<typeof contextPrSchema>;
export type ContextDoc = z.infer<typeof contextDocSchema>;
export type ContextChat = z.infer<typeof contextChatSchema>;
export type WorkSummary = z.infer<typeof workSummarySchema>;
export type WorkState = z.infer<typeof workStateSchema>;
export type Filed = z.infer<typeof filedSchema>;
export type Attached = PayloadOf<"work_attach_result">;
export type UsageWindowReport = z.infer<typeof usageWindowSchema>;
export type MemberUsage = z.infer<typeof memberUsageSchema>;
export type QueuedReport = z.infer<typeof queuedReportSchema>;
export type ChatOrigin = z.infer<typeof chatOriginSchema>;
export type ChatFile = z.infer<typeof chatFileSchema>;
export type Human = z.infer<typeof humanSchema>;
export type Member = z.infer<typeof memberSchema>;
export type AnswerState = z.infer<typeof answerStateSchema>;
export type DoctorCheckReport = z.infer<typeof doctorCheckSchema>;

export interface MessageMeta {
  /** Who sends it. */
  from: "agent" | "office" | "both";
  summary: string;

  /** Message types that may answer it; empty for messages that are not requests. */
  replies: MessageType[];
}

export type DecodeResult =
  | { ok: true; message: Message }
  | { ok: false; code: ErrorCode; message: string; id?: string };

/** One piece of work: a ticket, or a pull request without one, with the follow-ups on it. */
export interface WorkGroup {
  key: string;
  ticketKey?: string;
  ticketTitle?: string;
  pr?: string;
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;

  /** Title of the first item, for work that has neither a ticket nor a pull request. */
  title: string;

  /** The items of the group, in the order they were given. */
  items: WorkSummary[];
}
