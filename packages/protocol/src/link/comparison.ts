import { z } from "zod";
import { time } from "./fields.js";

const as = z
  .string()
  .describe(
    "Whom the change is attributed to: `office` for the engine; for the pipeline, the agent the office makes it for.",
  );

const policy = z
  .string()
  .optional()
  .describe("The pipeline policy behind it, on the pipeline's side.");

/** What one side did about an event, in the shape the engine and the pipeline share. */
export const outcomeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("wake"),
    person: z.string(),
    kind: z.string(),
    subject: z.strictObject({ type: z.string(), ref: z.string() }).optional(),
    policy,
  }),
  z.strictObject({ type: z.literal("move"), ticket: z.string(), to: z.string(), as, policy }),
  z.strictObject({
    type: z.literal("assign"),
    ticket: z.string(),
    to: z.strictObject({ kind: z.enum(["agent", "human"]), id: z.string() }).nullable(),
    as,
    policy,
  }),
  z.strictObject({ type: z.literal("comment"), on: z.string(), as, policy }),
  z.strictObject({
    type: z.literal("set_parent"),
    ticket: z.string(),
    parent: z.string(),
    as,
    policy,
  }),
]);

const noted = z.array(z.strictObject({ outcome: outcomeSchema, note: z.string() }));

/** In shadow mode: what the engine did for the same event. */
export const engineSchema = z.strictObject({
  effects: z
    .array(outcomeSchema)
    .describe(
      "What it applied, with the schedules it skipped because that work was already queued or running.",
    ),
  skipped: noted.optional().describe("What it decided but did not apply, and why."),
  failed: noted.optional().describe("What it tried and failed to apply, and why."),
});

export const DIFFERENCE_KINDS = [
  "missing_in_pipeline",
  "extra_in_pipeline",
  "different",
  "actor_changed",
] as const;

export const differenceSchema = z.strictObject({
  kind: z
    .enum(DIFFERENCE_KINDS)
    .describe(
      "`missing_in_pipeline`: the engine did it, the pipeline would not; `extra_in_pipeline`: the reverse; `different`: both act on the same target differently; `actor_changed`: the same change, attributed to the agent it is made for instead of to the office alone (not a different outcome).",
    ),
  engine: outcomeSchema.optional(),
  pipeline: outcomeSchema.optional(),
  policy: z.string().optional().describe("The pipeline policy behind the pipeline's side."),
  note: z.string().optional(),
});

/** In shadow mode: how the engine's outcome and the pipeline's compare. */
export const comparisonSchema = z.strictObject({
  agree: z.boolean().describe("True when every difference is `actor_changed`."),
  differences: z.array(differenceSchema),
});

/** Comparisons over many events: the `compare` method, and `ost explain --compare --json`. */
export const comparisonSummarySchema = z.strictObject({
  since: time.optional(),
  until: time.optional(),
  events: z.number().int().describe("Events traced in the range."),
  compared: z
    .number()
    .int()
    .describe("Those of them with the engine's side recorded (shadow mode)."),
  agree: z.number().int(),
  differ: z.number().int(),
  byKind: z
    .partialRecord(z.enum(DIFFERENCE_KINDS), z.number().int())
    .describe("Differences per kind."),
  byPolicy: z
    .record(z.string(), z.number().int())
    .describe(
      "Differences per pipeline policy; `(none)` where no policy is behind the pipeline's side.",
    ),
  differing: z
    .array(
      z.strictObject({
        id: z.string(),
        type: z.string(),
        at: time,
        differences: z.array(differenceSchema),
      }),
    )
    .describe("The events that differ, newest first."),
});
