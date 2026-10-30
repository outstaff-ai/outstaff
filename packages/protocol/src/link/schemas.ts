import { z } from "zod";
import { itemSchema, itemSubjectSchema, itemSummarySchema, personSchema } from "./entities.js";
import { traceSchema } from "./trace.js";
import { time } from "./fields.js";
import { healthSchema } from "./health.js";

/** Version of the office link; the office sends it as the `Outstaff-Link-Version` header. */
export const LINK_VERSION = 2;

export const LINK_ERROR_CODES = [
  "unknown_method",
  "invalid",
  "not_found",
  "timeout",
  "failed",
] as const;

const requestId = z
  .string()
  .min(1)
  .max(200)
  .describe("Chosen by the service; the response carries it back.");

const limit = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe("How many, at most. Default 50.");

/** The longest window `activity` counts: 30 days. */
export const MAX_WINDOW_SECONDS = 30 * 24 * 3600;

/** What the service can ask the office, and with what. */
export const requestSchema = z.discriminatedUnion("method", [
  z.strictObject({
    id: requestId,
    method: z.literal("people"),
    params: z.strictObject({}).optional(),
  }),
  z.strictObject({
    id: requestId,
    method: z.literal("events"),
    params: z
      .strictObject({
        since: time.optional().describe("Only events after this time."),
        before: time
          .optional()
          .describe("Only events before this time: the cursor for the next page."),
        limit,
        source: z
          .string()
          .min(1)
          .optional()
          .describe("Only events from this source, for example `vcs` or `tracker`."),
        person: z
          .string()
          .min(1)
          .optional()
          .describe("Only events this person caused, or that wake or act as them."),
        ticket: z.string().min(1).optional().describe("Only events about this ticket."),
        pr: z
          .string()
          .min(1)
          .optional()
          .describe("Only events about this pull request: `owner/name#number`."),
      })
      .optional(),
  }),
  z.strictObject({
    id: requestId,
    method: z.literal("event"),
    params: z.strictObject({ id: z.string().min(1).describe("The event's id, as in its trace.") }),
  }),
  z.strictObject({
    id: requestId,
    method: z.literal("items"),
    params: z
      .strictObject({
        status: itemSchema.shape.status.optional().describe("Only items with this status."),
        person: z.string().min(1).optional().describe("Only this person's items."),
        before: time
          .optional()
          .describe("Only items created before this time: the cursor for the next page."),
        limit,
      })
      .optional(),
  }),
  z.strictObject({
    id: requestId,
    method: z.literal("item"),
    params: z.strictObject({ id: z.string().min(1).describe("The work item's id.") }),
  }),
  z.strictObject({
    id: requestId,
    method: z.literal("activity"),
    params: z
      .strictObject({
        windows: z
          .array(z.number().int().min(1).max(MAX_WINDOW_SECONDS))
          .min(1)
          .max(10)
          .optional()
          .describe(
            "Window lengths in seconds, each counted back from now. Default one hour and one day.",
          ),
      })
      .optional(),
  }),
  z.strictObject({
    id: requestId,
    method: z.literal("health"),
    params: z
      .strictObject({
        run: z
          .boolean()
          .optional()
          .describe(
            "Run the office's checks now and answer with the result. A run that outlasts the request is answered with `timeout`; the `health` notification carries its result.",
          ),
      })
      .optional(),
  }),
]);

const results = {
  people: z.strictObject({ at: time, people: z.array(personSchema) }),
  events: z.strictObject({
    events: z.array(traceSchema).describe("Newest first."),
    total: z
      .number()
      .int()
      .describe("How many events match the filters, however many this page holds."),
    nextBefore: time
      .optional()
      .describe("Pass as `before` for the next page; absent when there are no more events."),
  }),
  event: z.strictObject({ trace: traceSchema }),
  items: z.strictObject({
    items: z.array(itemSummarySchema).describe("Newest first, by when they were created."),
    total: z
      .number()
      .int()
      .describe("How many items match the filters, however many this page holds."),
    nextBefore: time
      .optional()
      .describe("Pass as `before` for the next page; absent when there are no more items."),
  }),
  activity: z.strictObject({
    at: time.describe("The office's time of the count; each window ends here."),
    windows: z
      .array(
        z.strictObject({
          seconds: z.number().int().describe("The window's length, as requested."),
          since: time.describe("Where the window starts: `at` minus `seconds`."),
          events: z.number().int().describe("Events that happened in the window."),
          items: z.number().int().describe("Work items created in the window."),
        }),
      )
      .describe("In the order requested."),
  }),
  item: z.strictObject({
    item: itemSchema,
    traces: z
      .array(traceSchema)
      .describe("The events whose wakes queued or joined the item, oldest first."),
  }),
  health: healthSchema,
};

export const responseSchema = z.union([
  z.strictObject({
    id: z.string().describe("The request's `id`."),
    result: z.union([
      results.people,
      results.events,
      results.event,
      results.activity,
      results.items,
      results.item,
      results.health,
    ]),
  }),
  z.strictObject({
    id: z.string().describe("The request's `id`."),
    error: z.strictObject({ code: z.enum(LINK_ERROR_CODES), message: z.string() }),
  }),
]);

export const RESULT_SCHEMAS = results;

function message<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({ type: z.literal(type), payload });
}

export const linkMessageSchema = z.discriminatedUnion("type", [
  message(
    "welcome",
    z.strictObject({
      version: z.number().int().describe("LINK_VERSION the service speaks."),
      office: z
        .strictObject({ id: z.string().min(1), name: z.string().optional() })
        .describe("How the service knows this office."),
    }),
  ),
  message(
    "hello",
    z.strictObject({
      office: z
        .strictObject({
          team: z.string().describe("The team's name from its team file."),
          version: z.string().describe("The office's version."),
        })
        .describe("Which office this is."),
    }),
  ),
  message("request", requestSchema),
  message("response", responseSchema),
  message("people", results.people),
  message(
    "trace",
    z.strictObject({
      recordedAt: time.describe(
        "When the office recorded it. A trace is sent again when an act's result is added.",
      ),
      trace: traceSchema,
    }),
  ),
  message(
    "item",
    z.strictObject({
      id: z.string(),
      person: z.string(),
      kind: z.string(),
      title: z.string(),
      subject: itemSubjectSchema,
      status: itemSchema.shape.status,
      updatedAt: time,
    }),
  ),
  message("health", results.health),
  message("ping", z.strictObject({})),
  message("pong", z.strictObject({})),
]);
