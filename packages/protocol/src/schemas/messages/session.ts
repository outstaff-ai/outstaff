import { z } from "zod";
import { queuedActSchema } from "#/acts.js";
import { linkSchema, workItemSchema } from "#/schemas/common.js";
import { offerContextSchema } from "#/schemas/feedback.js";
import { itemId, message, text } from "#/schemas/fields.js";
import { usageWindowSchema } from "#/schemas/team.js";
import { queuedReportSchema } from "#/schemas/work.js";

export const sessionMessages = [
  message(
    "hello",
    z.strictObject({
      person: z.string().min(1).max(30).describe("Handle of the person this agent runs as."),
      token: z.string().min(1).max(500).describe("The person's agent token."),
      protocolVersion: z.number().int().describe("PROTOCOL_VERSION the agent speaks."),
      agentVersion: z.string().max(100).describe("Version of the agent software."),
    }),
  ),
  message(
    "welcome",
    z.strictObject({
      protocolVersion: z.number().int().describe("PROTOCOL_VERSION the office speaks."),
      heartbeatMs: z.number().int().positive().describe("Send a heartbeat at least this often."),
      team: z
        .record(z.string(), z.unknown())
        .describe(
          "The team config the office loaded, validated and with its defaults filled in. The agent validates it again, renders its working files from it and, when a later welcome brings a different one, renders them again between work items. It holds no secrets: the team file names the secrets adapters need, and each agent reads its own from its secret source.",
        ),
      resume: z
        .array(z.string())
        .describe("Ids of accepted, unfinished items the agent should carry on with."),
      reports: z
        .array(queuedReportSchema)
        .optional()
        .describe(
          "Reports to a requester that the agent did not post when its item ended, because it was offline. The agent posts each one now, as itself; the office does not send them again.",
        ),
      acts: z
        .array(queuedActSchema)
        .optional()
        .describe(
          "Acts the agent has not answered yet, for example because it was offline when the office decided them. The agent makes each one's changes now, as itself, and answers with `act_result`.",
        ),
    }),
  ),
  message(
    "offer",
    z.strictObject({
      workItem: workItemSchema.describe("The item to work on."),
      context: offerContextSchema.describe("What the agent needs to start."),
      sessionId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Runtime session of this item from an earlier round; resume it when present."),
      interrupted: z
        .boolean()
        .optional()
        .describe(
          "True when the item's previous run was cut short by an agent shutdown; the prompt says so.",
        ),
    }),
  ),
  message(
    "accept",
    z.strictObject({
      workItemId: itemId,
      runtime: z
        .string()
        .min(1)
        .max(100)
        .describe("The runtime adapter this agent runs the item on, for example `claude`."),
      model: z
        .string()
        .min(1)
        .max(200)
        .describe("The model the person is configured with (`people[].model`)."),
    }),
  ),
  message(
    "decline",
    z.strictObject({
      workItemId: itemId,
      reason: text.describe("Why the agent cannot take it now."),
    }),
  ),
  message(
    "heartbeat",
    z.strictObject({ workItemId: itemId.optional().describe("The item being worked on, if any.") }),
  ),
  message("progress", z.strictObject({ workItemId: itemId, text: text })),
  message(
    "session",
    z.strictObject({
      workItemId: itemId,
      sessionId: z.string().min(1).max(200).describe("Id of the runtime session working the item."),
      model: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "The concrete model id the runtime reports it started with, when it reports one (for example the full id behind an alias).",
        ),
    }),
  ),
  message(
    "usage",
    z.strictObject({
      windows: z
        .array(usageWindowSchema)
        .max(20)
        .describe("The runtime's current LLM usage windows; replaces the earlier report."),
    }),
  ),
  message("journal", z.strictObject({ workItemId: itemId, text: text })),
  message(
    "handback",
    z.strictObject({
      workItemId: itemId,
      summary: text.describe("What was done, decisions and open points."),
      links: z.array(linkSchema).describe("Pull requests, documents and tickets touched."),
      status: z
        .enum(["done", "waiting", "blocked", "interrupted"])
        .describe(
          "Whether the item is finished, waits for something, is stuck, or was cut short by the agent shutting down. An interrupted item goes back to the front of the queue and is offered again with its session.",
        ),
    }),
  ),
  message("fail", z.strictObject({ workItemId: itemId, reason: text })),
] as const;
