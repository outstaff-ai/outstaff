import { z } from "zod";
import { chatOriginSchema, linkSchema } from "./common.js";

export const text = z.string().min(1).max(100_000);
export const itemId = z.string().min(1).max(200).describe("Id of the work item.");

export const empty = z.strictObject({});

/** Where and how the agent posts a report to the requester; shared by `chat_report_result` and queued reports. */
export const reportWhere = {
  requester: z.string().optional().describe("Id of the requester to mention."),
  links: z.array(linkSchema).describe("The ticket and pull requests of the item."),
  threads: z
    .array(chatOriginSchema.omit({ about: true, files: true }))
    .optional()
    .describe(
      "Every thread linked to the item now, to post the report in: the one it came from and the ones attached later. Absent when the report goes to a direct message instead.",
    ),
  direct: z
    .string()
    .optional()
    .describe(
      "For a blocked report on an item without a chat thread: the requester's chat user id. Open a direct message with them and post the report there.",
    ),
};

export function message<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({
    id: z.string().min(1).max(200).describe("Unique id of this message."),
    replyTo: z.string().min(1).max(200).optional().describe("Id of the request this answers."),
    type: z.literal(type),
    payload,
  });
}
