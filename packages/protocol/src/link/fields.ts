import { z } from "zod";

export const time = z.string().min(1).describe("ISO-8601 time, UTC.");

export const itemSubjectSchema = z
  .strictObject({ type: z.string(), ref: z.string() })
  .nullable()
  .describe(
    "What the item is about: a ticket key, a pull request (`host/owner/name#n`) or a document id.",
  );
