import { z } from "zod";
import { ERROR_CODES } from "#/constants.js";
import { doctorCheckSchema } from "#/schemas/doctor.js";
import { empty, itemId, message } from "#/schemas/fields.js";

export const otherMessages = [
  message(
    "doc_link",
    z.strictObject({
      workItemId: itemId,
      doc: z.strictObject({
        id: z.string().min(1).max(500).describe("Id of the document in the knowledge base."),
        title: z.string().max(500).describe("Title of the document."),
        url: z.string().min(1).describe("Absolute URL of the document."),
      }),
    }),
  ),
  message(
    "doctor_report",
    z.strictObject({
      checks: z
        .array(doctorCheckSchema)
        .max(500)
        .describe("Every check the agent ran at start; replaces its earlier report."),
    }),
  ),
  message("current_work", empty),
  message("current_work_result", z.strictObject({ text: z.string() })),
  message(
    "ticket_prs",
    z.strictObject({
      headRef: z.string().min(1).max(250).describe("Branch the pull request would be opened from."),
      title: z.string().min(1).max(256).describe("Title it would have."),
      body: z.string().max(65_000).describe("Description it would have."),
    }),
  ),
  message(
    "ticket_prs_result",
    z.strictObject({
      ticket: z
        .string()
        .optional()
        .describe(
          "The ticket the pull request would link to, by the rule that links existing ones (branch, then title, then a closing keyword in the body; a bare mention links nothing); absent when it would link to none.",
        ),
      prs: z
        .array(
          z.strictObject({
            ref: z.string().describe("Pull request, for example `acme/shop#12`."),
            number: z.number().int(),
            title: z.string(),
            url: z.string().optional(),
            state: z.enum(["open", "closed", "merged"]),
            authorKind: z.enum(["human", "agent", "bot"]),
          }),
        )
        .describe("The pull requests already linked to that ticket, in any state."),
    }),
  ),
  message("ack", empty),
  message(
    "error",
    z.strictObject({
      code: z.enum(ERROR_CODES),
      message: z.string(),
    }),
  ),
  message("ping", empty),
  message("pong", empty),
] as const;
