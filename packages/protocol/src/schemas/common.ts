import { z } from "zod";
import { MAX_CHAT_FILES } from "#/constants.js";

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
