import { z } from "zod";
import { itemId, reportWhere } from "./fields.js";

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

/** The state of one work item as its asker may see it. Items of someone else are only `not_yours`. */
export const workStateSchema = z.strictObject({
  workItemId: itemId,
  state: z
    .enum(["queued", "active", "waiting", "blocked", "done", "canceled", "not_yours", "unknown"])
    .describe(
      "The item's status. `not_yours` when it belongs to someone else, whatever its status; `unknown` when the office has no such item.",
    ),
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

/** A report the agent was not online to post, handed to it when it connects. */
export const queuedReportSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(300)
    .describe(
      "Id of this report. The office sends it again until the agent confirms with `report_posted`, so the agent skips an id it posted already.",
    ),
  workItemId: itemId,
  kind: z.enum(["result", "blocked"]).describe("How the item ended."),
  text: z.string().describe("What the agent handed back: the summary to report."),
  ...reportWhere,
});
