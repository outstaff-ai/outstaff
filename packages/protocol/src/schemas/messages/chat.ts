import { z } from "zod";
import { MAX_CHAT_FILES } from "#/constants.js";
import { chatFileSchema, linkSchema } from "#/schemas/common.js";
import { itemId, message, reportWhere } from "#/schemas/fields.js";
import { queuedReportSchema, workSummarySchema } from "#/schemas/work.js";

export const chatMessages = [
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
        .enum(["received", "started", "limited", "joined", "placed", "asked_pm", "unclear"])
        .describe(
          "What the office did: `received` the message as an event its pipeline decides on (`office.pipeline: live`); with the chat desk, `started` a chat session for the message, or held it as `limited` until a chat session is free, `joined` an item of the thread, `placed` the item waiting for its place, `asked_pm` to prioritize it, or could not read the answer (`unclear`).",
        ),
      repeated: z.boolean().describe("True when the office already handled this message."),
      item: workSummarySchema
        .optional()
        .describe("The item the message belongs to; absent for `received`, which queues later."),
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
        .describe(
          "False when nothing should be posted: no chat origin and no blocked report to the requester, or already reported.",
        ),
      ...reportWhere,
    }),
  ),
  message(
    "reports",
    z.strictObject({
      reports: z
        .array(queuedReportSchema)
        .describe("Reports to requesters the agent has not confirmed posting yet."),
    }),
  ),
  message(
    "report_posted",
    z.strictObject({
      workItemId: itemId,
      id: z.string().min(1).max(300).describe("The `id` of the report the agent posted."),
    }),
  ),
] as const;
