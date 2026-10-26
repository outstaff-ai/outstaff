import { z } from "zod";

const ticket = z.string().min(1).max(100).describe("Key of the ticket, for example ACME-123.");

/** One tracker or knowledge-base change of an act. */
export const actOpSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("move"),
    ticket,
    to: z
      .enum(["backlog", "ready", "active", "review", "blocked", "done", "canceled"])
      .describe("The canonical status to move the ticket to."),
  }),
  z.strictObject({
    op: z.literal("assign"),
    ticket,
    to: z
      .strictObject({
        kind: z.enum(["agent", "human"]),
        id: z
          .string()
          .min(1)
          .max(200)
          .describe("An agent's handle, or a human's tracker identity from the team file."),
      })
      .nullable()
      .describe("Who to assign the ticket to; null unassigns it."),
  }),
  z.strictObject({
    op: z.literal("comment"),
    on: z.union([
      z.strictObject({ ticket }),
      z.strictObject({ doc: z.string().min(1).max(500).describe("Id of the document.") }),
    ]),
    body: z.string().min(1).max(65_000).describe("The comment, as the agent posts it."),
  }),
  z.strictObject({
    op: z.literal("set_parent"),
    ticket,
    parent: ticket.describe("Key of the parent ticket."),
  }),
]);
