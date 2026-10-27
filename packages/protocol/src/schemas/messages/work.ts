import { z } from "zod";
import { refSchema } from "../common.js";
import { empty, itemId, message, text } from "../fields.js";
import { answerStateSchema, humanSchema, memberSchema } from "../team.js";
import { filedSchema, workSummarySchema } from "../work.js";

export const workMessages = [
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
      request: z.string().min(1).max(300).describe("Title of the request the ticket files."),
    }),
  ),
  message(
    "work_check",
    z.strictObject({
      workItemId: itemId,
      request: z.string().min(1).max(300).describe("Title of the request about to be filed."),
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
] as const;
