import { z } from "zod";
import { ticketUsageSchema, usageTotalsSchema } from "#/schemas/usage.js";
import { itemSubjectSchema, time } from "./fields.js";

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

/** The longest period `period_usage` counts: 400 days, a year with room for its time zone. */
export const MAX_PERIOD_DAYS = 400;

export const PERIOD_GROUPS = ["person", "subject", "model", "day", "month"] as const;

export const periodUsageParamsSchema = z.strictObject({
  from: time.describe("Start of the period: count run time from here."),
  to: time.optional().describe("End of the period, not included. Default now."),
  tz: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("IANA time zone of the days and months, for example `Europe/Lisbon`. Default UTC."),
  groupBy: z
    .array(z.enum(PERIOD_GROUPS))
    .max(PERIOD_GROUPS.length)
    .optional()
    .describe(
      'The keys of each group, combined: `["person", "day"]` gives one group per person and day. Default none: only the totals.',
    ),
});

const seconds = z.number().min(0);

/** Usage totals of a period, with the time the runs took. */
export const periodTotalsSchema = usageTotalsSchema.extend({
  runSeconds: seconds.describe(
    "The runs' time in the period, added up: overlapping runs each count.",
  ),
  busySeconds: seconds.describe(
    "For each person, the time in the period that at least one of their runs was going, added up over the people: overlapping runs of a person count once.",
  ),
});

export const periodUsageResultSchema = z.strictObject({
  from: time,
  to: time,
  tz: z.string(),
  groupBy: z.array(z.enum(PERIOD_GROUPS)),
  totals: periodTotalsSchema.describe("The whole period."),
  groups: z
    .array(
      z.strictObject({
        person: z.string().optional().describe("The handle; with `person` in `groupBy`."),
        subject: itemSubjectSchema
          .optional()
          .describe("The work item's subject, null for none; with `subject` in `groupBy`."),
        model: z
          .string()
          .nullable()
          .optional()
          .describe(
            "The model id, null for runs that reported no usage; with `model` in `groupBy`. A run that used two models counts its time in both, so the time of the models does not add up to the totals.",
          ),
        day: z.string().optional().describe("YYYY-MM-DD in `tz`; with `day` in `groupBy`."),
        month: z.string().optional().describe("YYYY-MM in `tz`; with `month` in `groupBy`."),
        totals: periodTotalsSchema,
      }),
    )
    .describe(
      "Each group with run time in the period: by day and month oldest first, then largest cost first.",
    ),
});
