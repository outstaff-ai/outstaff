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
  z.strictObject({
    op: z.literal("link_pr"),
    ticket,
    pr: z
      .strictObject({
        repo: z.strictObject({
          owner: z.string().min(1).max(200).describe("Owner of the repository."),
          name: z.string().min(1).max(200).describe("Name of the repository."),
          host: z.string().min(1).max(200).optional().describe("Host of the code host."),
        }),
        number: z.int().positive().describe("Number of the pull request."),
        url: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe("The pull request's page on the code host."),
      })
      .describe("The pull request to show in the ticket's development section."),
  }),
]);

/** Tracker or knowledge-base changes for the agent to make as itself, without a model run. */
export const queuedActSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "Id of the act. The office sends it again until the agent answers with `act_result`, so the agent makes an id's changes once and only answers again.",
    ),
  ops: z.array(actOpSchema).min(1).max(20).describe("The changes, made in order."),
});
