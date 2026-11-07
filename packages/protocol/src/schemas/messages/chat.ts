import { z } from "zod";
import { MAX_CHAT_FILES } from "#/constants.js";
import { chatFileSchema } from "#/schemas/common.js";
import { empty, itemId, message, reportWhere } from "#/schemas/fields.js";
import { queuedReportSchema } from "#/schemas/work.js";

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
      at: z
        .string()
        .min(1)
        .max(40)
        .describe(
          "When the author wrote it, as the chat has it (ISO-8601). The office keeps the latest per conversation, where the agent catches up from.",
        ),
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
      repeated: z.boolean().describe("True when the office already took this message in."),
    }),
  ),
  message("chat_cursors", empty),
  message(
    "chat_cursors_result",
    z.strictObject({
      cursors: z
        .array(
          z.strictObject({
            channel: z.string().min(1).max(200),
            thread: z
              .string()
              .min(1)
              .max(200)
              .optional()
              .describe("The thread; absent for the top level of the channel or direct message."),
            at: z
              .string()
              .describe("When the last message the office took in was written (ISO-8601)."),
          }),
        )
        .describe("The caller's conversations, latest first, each with its last message's time."),
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
