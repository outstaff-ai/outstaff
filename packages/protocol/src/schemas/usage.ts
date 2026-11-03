import { z } from "zod";

const tokenCount = z.number().int().min(0);
const cost = z
  .number()
  .min(0)
  .describe(
    "What the tokens cost at API list prices, in USD. API-equivalent: on a subscription it is not what is billed.",
  );

/** Tokens and cost of one model, as a runtime reports them. */
export const modelUsageSchema = z.strictObject({
  inputTokens: tokenCount.describe("Input tokens not read from the cache."),
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount.describe("Input tokens read from the prompt cache."),
  cacheCreationTokens: tokenCount.describe("Input tokens written to the prompt cache."),
  costUsd: cost.optional().describe("Absent when the runtime has no price for the model."),
});

/** One runtime session's usage so far, as the runtime last reported it in the item's round. */
export const sessionUsageReportSchema = z.strictObject({
  session: z.string().min(1).max(200).describe("Id of the runtime session."),
  models: z
    .record(z.string().min(1).max(200), modelUsageSchema)
    .describe(
      "The session's running total per model id, as the runtime reports it: a resumed session includes its earlier rounds, and the office counts only what is new since the session's previous report.",
    ),
});

export const runUsageReportSchema = z
  .array(sessionUsageReportSchema)
  .max(20)
  .describe(
    "The usage of the round, per runtime session it used (a lost session restarted gives two), in the latest figures the runtime reported.",
  );

/** Summed usage: the four token counts, their total, the API-equivalent cost and how many runs it covers. */
export const usageTotalsSchema = z.strictObject({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  tokens: tokenCount.describe("All four token counts added up."),
  costUsd: cost,
  runs: z.number().int().min(0).describe("Runs counted."),
});

/** One group of a breakdown: who, which model or which kind of round, and its totals. */
const usageGroupSchema = z.strictObject({
  key: z.string().describe("The person's handle, the model id, or the kind of round."),
  totals: usageTotalsSchema,
});

const breakdown = (what: string) => z.array(usageGroupSchema).describe(what);

/** A ticket's usage: its own runs, broken down, and its total with its sub-tickets rolled up. */
export const ticketUsageSchema = z.strictObject({
  ticket: z.string().describe("Key of the ticket."),
  own: usageTotalsSchema.describe(
    "Every run of every work item whose subject or references name the ticket: its own rounds, reviews and merges of its pull requests, comment rounds and chat sessions attached to it.",
  ),
  total: usageTotalsSchema.describe("The ticket's own usage plus its sub-tickets' totals."),
  subTickets: z
    .array(z.strictObject({ ticket: z.string(), total: usageTotalsSchema }))
    .describe("The sub-tickets rolled into `total`, each with its own total."),
  byPerson: breakdown("The ticket's own usage per person, largest cost first."),
  byModel: breakdown("The ticket's own usage per model id, largest cost first."),
  byKind: breakdown(
    "The ticket's own usage per kind of round (the work item's kind, for example `assigned` or `review_feedback`), largest cost first.",
  ),
});
