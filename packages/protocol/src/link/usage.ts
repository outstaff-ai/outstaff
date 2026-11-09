import { z } from "zod";
import { ticketUsageSchema, usageTotalsSchema } from "#/schemas/usage.js";
import { time } from "./fields.js";

const modelsField = (of: string) =>
  z
    .array(z.strictObject({ model: z.string(), totals: usageTotalsSchema }))
    .describe(`Per model id ${of} called, largest cost first.`);

/** One run's usage: its totals and the same per model. */
export const runUsageSchema = z
  .strictObject({ totals: usageTotalsSchema, models: modelsField("the run") })
  .nullable()
  .describe(
    "The tokens and API-equivalent cost of the run; null when the agent reported none (an unfinished run, or one that ended without the agent).",
  );

/** A work item's usage: its runs' usage added up, and the same per model. */
export const itemUsageSchema = z
  .strictObject({
    totals: usageTotalsSchema.describe(
      "Every run of the item that reported usage; `runs` counts them, so fewer than the item's runs means some reported none.",
    ),
    models: modelsField("the item's runs"),
  })
  .describe(
    "The tokens and API-equivalent cost of the item's runs, all zero when none reported any.",
  );

export const ticketUsageParamsSchema = z.strictObject({
  ticket: z.string().min(1).max(100).describe("Key of the ticket."),
});

export const usageParamsSchema = z
  .strictObject({
    since: time.optional().describe("Count runs that finished at or after this time."),
    until: time.optional().describe("Count runs that finished before this time. Default now."),
  })
  .optional();

export const usageResultSchema = z.strictObject({
  since: time.nullable().describe("As asked; null for since the start."),
  until: time,
  byPerson: z
    .array(
      z.strictObject({
        person: z.string(),
        totals: usageTotalsSchema.describe("Every run of the person."),
        unattributed: usageTotalsSchema.describe(
          "The person's runs of work items that name no ticket, for example a chat that filed nothing.",
        ),
      }),
    )
    .describe("Each person with runs in the window, largest cost first."),
  byDay: z
    .array(
      z.strictObject({ day: z.string().describe("YYYY-MM-DD, UTC."), totals: usageTotalsSchema }),
    )
    .describe("Each day with runs in the window, by when the runs finished, oldest first."),
});

export const ticketUsageResultSchema = ticketUsageSchema;
