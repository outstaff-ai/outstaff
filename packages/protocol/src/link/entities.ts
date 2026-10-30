import { z } from "zod";
import { time } from "./fields.js";

export const itemSubjectSchema = z
  .strictObject({ type: z.string(), ref: z.string() })
  .nullable()
  .describe(
    "What the item is about: a ticket key, a pull request (`host/owner/name#n`) or a document id.",
  );

const runtimeField = z
  .string()
  .nullable()
  .describe("The runtime adapter that ran it, for example `claude`; null until the agent said.");

const modelField = z
  .string()
  .nullable()
  .describe(
    "The model that ran it: the concrete id the runtime reported, else the one the person is configured with; null when neither is known.",
  );

const itemFields = {
  id: z.string().describe("Id of the work item."),
  kind: z.string().describe("What the item is, for example `assigned` or `review_feedback`."),
  title: z.string(),
  subject: itemSubjectSchema,
};

/** The pipeline policy and event that queued an item. */
export const scheduledBySchema = z.strictObject({
  policy: z.string().describe("Id of the policy that decided the wake."),
  eventId: z.string().describe("Id of the event it decided on: the `id` of its trace."),
});

export const personSchema = z.strictObject({
  handle: z.string(),
  name: z.string(),
  role: z.string(),
  runtime: z
    .string()
    .describe(
      "The runtime adapter the person is configured with, for example `claude`: their own `runtime`, else the team's `integrations.runtime`.",
    ),
  model: z
    .string()
    .describe(
      "The model the person is configured with: their `model` from `team.yaml`, which every person has.",
    ),
  connected: z.boolean().describe("Whether the person's agent is connected to the office now."),
  counts: z
    .strictObject({
      queued: z.number().int().describe("Items waiting to run."),
      running: z.number().int().describe("Items running now."),
    })
    .describe("How much work the person has."),
  current: z
    .strictObject({
      ...itemFields,
      startedAt: time.nullable().describe("When the item's current run started."),
      runtime: runtimeField.describe("The runtime adapter running the current run, once it said."),
      model: modelField.describe("The model of the current run, once known."),
      lastHeartbeat: time.describe("The item's latest sign of life."),
    })
    .nullable()
    .describe("The item the agent is working on; null when idle."),
  queue: z
    .array(
      z.strictObject({
        ...itemFields,
        priority: z.number().int().describe("Lower runs first."),
        trigger: z.enum(["human", "agent", "automation", "schedule"]),
        reason: z.string().describe("Why the item is queued, in words."),
        scheduledBy: scheduledBySchema
          .nullable()
          .describe(
            "The policy and event that queued it, when the event pipeline did; null otherwise.",
          ),
      }),
    )
    .describe("Queued items, in the order they run."),
});

/** One work item in full: what it is, its runs, and the end of its journal. */
export const itemSchema = z.strictObject({
  ...itemFields,
  person: z.string(),
  status: z.enum(["queued", "active", "waiting", "done", "blocked", "canceled"]),
  priority: z.number().int(),
  trigger: z.enum(["human", "agent", "automation", "schedule"]),
  createdAt: time,
  updatedAt: time,
  scheduledBy: scheduledBySchema
    .nullable()
    .describe("The policy and event that queued it, when the event pipeline did."),
  runs: z
    .array(
      z.strictObject({
        startedAt: time,
        finishedAt: time.nullable(),
        outcome: z
          .string()
          .nullable()
          .describe("How the run ended, for example `done` or `blocked`."),
        error: z.string().nullable(),
        runtime: runtimeField,
        model: modelField,
      }),
    )
    .describe("Every run, oldest first."),
  journal: z
    .strictObject({
      entries: z.number().int().describe("How many entries the journal has."),
      latest: z
        .array(z.strictObject({ at: time, author: z.string(), text: z.string() }))
        .describe("The latest few entries, oldest first; long ones are cut."),
    })
    .describe("The item's journal, in short."),
});

/** A work item in a list: the item without its runs and journal. */
export const itemSummarySchema = itemSchema.omit({ runs: true, journal: true });
