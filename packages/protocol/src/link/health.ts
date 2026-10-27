import { z } from "zod";
import { doctorCheckSchema } from "#/schemas/doctor.js";
import { time } from "./fields.js";

/** One stored check: the latest finding, and since when it has this status. */
export const healthCheckSchema = doctorCheckSchema.extend({
  scope: z
    .string()
    .describe(
      "Whose check it is: `office` for the checks the office runs, else the handle of the person whose agent reported it.",
    ),
  firstSeen: time.describe("When the check first reported this status."),
  lastSeen: time.describe("When a run last reported the check."),
});

/** The doctor checks as the office holds them now. */
export const healthSchema = z.strictObject({
  at: time,
  summary: z
    .strictObject({
      ok: z.number().int(),
      warn: z.number().int(),
      fail: z.number().int(),
    })
    .describe("How many checks have each status."),
  lastRun: time
    .nullable()
    .describe("When the office last ran its own checks; null before the first run ends."),
  checks: z
    .array(healthCheckSchema)
    .describe(
      "Every check, failures first, then warnings, then the rest; by scope and name within each.",
    ),
});
