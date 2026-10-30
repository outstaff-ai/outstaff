import { z } from "zod";
import { actOpSchema } from "#/acts.js";
import { feedbackSchema } from "#/schemas/index.js";
import { time } from "./fields.js";

const wakeSubject = z.strictObject({
  type: z.enum(["pr", "ticket", "doc", "chat"]),
  ref: z.string(),
});

const decisionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("wake"),
    policy: z
      .string()
      .describe("The policy that proposed it; the first, when the wakes of several were merged."),
    person: z.string(),
    kind: z.string(),
    instruction: z.string(),
    feedback: z.array(feedbackSchema),
    subject: wakeSubject,
    coalesceMs: z
      .number()
      .int()
      .describe(
        "How long the run waits for related wakes to join it, in milliseconds: 0 for a chat message and an idle pull.",
      ),
    itemId: z
      .string()
      .optional()
      .describe("The work item the wake queued or joined, when the pipeline is live."),
    folded: z
      .array(z.string())
      .optional()
      .describe(
        "Set when the wake joined an item an earlier one queued: every event of that item so far.",
      ),
  }),
  z.strictObject({
    type: z.literal("act"),
    policy: z.string(),
    as: z
      .string()
      .describe(
        "The agent who makes the changes, through its own process and with its own account.",
      ),
    ops: z.array(actOpSchema),
    note: z
      .string()
      .optional()
      .describe("A comment the agent posts on the ticket after the changes."),
  }),
  z.strictObject({ type: z.literal("drop"), policy: z.string().optional(), reason: z.string() }),
]);

const reason = z.string().describe("Why, in words.");

/** What a policy proposed for an event; the aggregation turns the proposals into the decisions. */
const proposalSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("wake"),
    person: z.string(),
    kind: z.string(),
    instruction: z.string(),
    subject: wakeSubject
      .optional()
      .describe("What the run is about; the event's subject when absent."),
    reason,
  }),
  z.strictObject({
    type: z.literal("act"),
    as: z.string(),
    ops: z.array(actOpSchema),
    note: z.string().optional(),
    reason,
  }),
  z.strictObject({ type: z.literal("drop"), reason }),
  z.strictObject({
    type: z.literal("suppress"),
    person: z.string(),
    subject: wakeSubject.optional(),
    kind: z.string().optional(),
    reason,
  }),
  z.strictObject({ type: z.literal("error"), reason }).describe("The policy threw."),
]);

const prRef = z.strictObject({
  repo: z.strictObject({ host: z.string(), owner: z.string(), name: z.string() }),
  number: z.number().int(),
});

/** What the event pipeline decided for one event, and why. */
export const traceSchema = z.strictObject({
  event: z.strictObject({
    id: z.string().describe("`<source>:<external id>`; the id `ost explain` takes."),
    source: z
      .enum(["vcs", "tracker", "knowledge", "chat", "office"])
      .describe(
        "Where the event came from: the code host, the tracker, the knowledge base, chat, or the office itself.",
      ),
    type: z.string(),
    at: time.describe("When the event happened."),
    subject: z.strictObject({
      ticket: z.string().optional(),
      pr: prRef.optional(),
      doc: z.string().optional(),
      chat: z.strictObject({ channel: z.string(), thread: z.string().optional() }).optional(),
    }),
    actor: z.strictObject({ kind: z.enum(["human", "agent", "automation"]), id: z.string() }),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        "Event data as intake normalized it: a ticket move has canonical statuses in `from` and `to` and the tracker's names in `fromName` and `toName`.",
      ),
  }),
  urls: z
    .strictObject({
      ticket: z.string().optional(),
      pr: z.string().optional(),
      doc: z.string().optional(),
      chat: z.string().optional(),
    })
    .describe("Links to the event's subject, where the office can resolve them."),
  policies: z
    .array(
      z.strictObject({
        policy: z.string(),
        matched: z.boolean(),
        reason: z.string().describe("Why it matched or did not."),
        failed: z
          .unknown()
          .optional()
          .describe("For a policy that listened but did not match: the condition that failed."),
        proposals: z.array(proposalSchema).describe("What it proposed, when it matched."),
      }),
    )
    .describe("Every policy, built-in then custom, in order."),
  aggregation: z
    .array(
      z.strictObject({
        policy: z.string(),
        proposal: z.number().int().describe("The proposal's index in its policy's `proposals`."),
        outcome: z
          .enum(["kept", "merged", "suppressed", "rejected", "dropped", "error"])
          .describe(
            "`kept` as a decision, `merged` into another wake of the same person and subject, `suppressed` by another policy, `rejected` by an invariant, `dropped` as pointless or by a conflict it lost, `error` when the policy threw.",
          ),
        reason: z.string().optional(),
        decision: z
          .number()
          .int()
          .optional()
          .describe("The index in `decisions` of the decision it became or was merged into."),
      }),
    )
    .describe("What the aggregation made of each proposal, in order."),
  decisions: z.array(decisionSchema).describe("What the office does: the aggregation's result."),
  results: z
    .record(
      z.string(),
      z.strictObject({
        status: z
          .enum(["queued", "delivered", "done", "failed"])
          .describe(
            "`queued` until the agent is sent the act (it waits while the agent is offline), `delivered` once it is, then `done` or `failed` from the agent's answer.",
          ),
        queuedAt: time,
        deliveredAt: time.optional().describe("When the act was last sent to the agent."),
        finishedAt: time.optional().describe("When the agent's answer came."),
        results: z.array(z.string()).describe("One line per change the agent made, in order."),
        error: z
          .string()
          .optional()
          .describe("The change that failed and why; the changes after it were not tried."),
      }),
    )
    .optional()
    .describe(
      "Each act's progress, by act id (`<event id>:<policy>`): the agent it is for makes the changes, so an act for an offline agent waits until it connects.",
    ),
});
