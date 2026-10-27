import { z } from "zod";

/** One finding of the doctor checks, as `ost doctor` prints it. Never carries a secret value. */
export const doctorCheckSchema = z.strictObject({
  name: z.string().min(1).max(200).describe("What is checked, for example `Tools install`."),
  status: z.enum(["ok", "warn", "fail"]),
  detail: z.string().max(10_000).describe("What was found, naming the value that is wrong."),
  fix: z.string().max(10_000).optional().describe("What to change, when the check is not ok."),
  key: z
    .string()
    .max(200)
    .optional()
    .describe("The secret key the check is about, when it is about one."),
  adapter: z.string().max(100).optional().describe("The adapter that made the check, if one did."),
});
