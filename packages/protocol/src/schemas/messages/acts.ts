import { z } from "zod";
import { queuedActSchema } from "#/acts.js";
import { message } from "#/schemas/fields.js";

export const actMessages = [
  message("act", queuedActSchema),
  message(
    "act_result",
    z.strictObject({
      id: queuedActSchema.shape.id.describe("The `id` of the act."),
      ok: z.boolean().describe("True when every change was made."),
      results: z
        .array(z.string().max(1_000))
        .max(50)
        .describe("One line per change made, in order."),
      error: z
        .string()
        .max(2_000)
        .optional()
        .describe(
          "The change that failed and why. The changes after it were not tried; the ones before it stay made.",
        ),
    }),
  ),
] as const;
