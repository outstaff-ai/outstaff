import { z } from "zod";
import { journalEntrySchema, linkSchema, refSchema } from "./common.js";
import { wakeContextSchema } from "./context.js";

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
  actor: z
    .string()
    .min(1)
    .describe("Login of the person who gave the feedback; for a blocked hand-back, the agent."),
  kind: z
    .enum([
      "review",
      "comment",
      "inline_comment",
      "chat",
      "ticket_comment",
      "doc_comment",
      "blocked",
      "ci_failure",
    ])
    .describe(
      "A review with its summary, a comment on the pull request conversation, an inline comment on the diff, a message from a trusted human in chat, a comment on a ticket, a comment or reply on a knowledge document, an agent's hand-back as blocked (its last comment on the ticket), or the failing checks of a pull request (names, links and summaries, in the body).",
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
  wake: wakeContextSchema
    .optional()
    .describe(
      "What the office knows about the work, handed over with the wake: the linked tickets, pull requests, documents and chat threads, each with its link and why it belongs.",
    ),
});
