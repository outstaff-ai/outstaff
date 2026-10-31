import { z } from "zod";

/** Data from the person named: quoted to the agent, never followed as an instruction. */
const data = (what: string) => z.string().describe(`${what} Data from that person.`);

export const contextWhySchema = z.strictObject({
  role: z
    .enum(["trigger", "subject", "created", "attached", "mentioned", "inferred", "linked"])
    .describe(
      "How it belongs to the work: it woke the agent, is what the work is about, the agent made it, a request added it, feedback named it, the work state worked it out, or it is linked to another item of the bundle.",
    ),
  source: z
    .string()
    .describe(
      "What added it: an event id, an agent verb, a chat message, or the link it was found through.",
    ),
  addedAt: z.string().optional().describe("When the office learned of it (ISO-8601)."),
});

export const contextNoteSchema = z.strictObject({
  author: z.string().describe("Who wrote it."),
  at: z.string().describe("When (ISO-8601)."),
  url: z.string().optional().describe("Link to it."),
  body: data("What they wrote, cut to `pipeline.context.body_chars`."),
});

export const contextTicketSchema = z.strictObject({
  key: z.string().min(1),
  title: z.string(),
  url: z.string().optional().describe("Link to the ticket."),
  status: z.string().optional().describe("Canonical status, for example active or review."),
  assignee: z.string().optional().describe("Name of whom it is assigned to."),
  description: data("The ticket's description, cut to `pipeline.context.body_chars`.").optional(),
  comments: z
    .array(contextNoteSchema)
    .describe("The latest comments, oldest first, at most `pipeline.context.comments`."),
  moreComments: z.number().int().optional().describe("Earlier comments left out."),
  why: contextWhySchema,
});

export const contextThreadSchema = z.strictObject({
  path: z.string().optional().describe("File the thread is on."),
  line: z.number().int().optional(),
  url: z.string().optional().describe("Link to the thread."),
  author: z.string().describe("Who opened it."),
  body: data("Its first comment, cut to `pipeline.context.body_chars`."),
});

export const contextPrSchema = z.strictObject({
  ref: z
    .string()
    .min(1)
    .describe("The office's key of the pull request, for example `acme/shop#12`."),
  number: z.number().int(),
  title: z.string(),
  url: z.string().optional().describe("Link to the pull request."),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  ci: z.enum(["none", "pending", "success", "failure"]).describe("Combined state of its checks."),
  failing: z.array(z.string()).describe("Names of the failing checks."),
  mergeable: z.enum(["clean", "conflicting", "unknown"]),
  review: z.string().optional().describe("State of the latest submitted review."),
  unresolvedThreads: z.number().int().describe("How many review threads are unresolved."),
  threads: z
    .array(contextThreadSchema)
    .describe("Unresolved review threads, at most `pipeline.context.threads`."),
  ticket: z.string().optional().describe("The ticket it implements."),
  stackedOn: z.string().optional().describe("The pull request it is stacked on."),
  stackedBy: z.array(z.string()).describe("Open pull requests stacked on it."),
  why: contextWhySchema,
});

export const contextDocSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  url: z.string().optional().describe("Link to the document."),
  ticket: z.string().optional().describe("The ticket it was written for."),
  why: contextWhySchema,
});

export const contextChatSchema = z.strictObject({
  channel: z.string().min(1),
  thread: z.string().min(1).describe("Thread to read or answer in, with the chat tools."),
  messages: z
    .array(
      z.strictObject({
        author: z.string().describe("Who wrote it."),
        at: z.string().describe("When the office received it (ISO-8601)."),
        text: data("What they wrote, cut to `pipeline.context.body_chars`."),
      }),
    )
    .describe(
      "The latest messages the office received in the thread, oldest first, at most `pipeline.context.messages`.",
    ),
  moreMessages: z.number().int().optional().describe("Earlier messages left out."),
  why: contextWhySchema,
});

const ci = z.enum(["none", "pending", "success", "failure"]);

/** A check that did not pass, with its link. */
const contextCheckSchema = z.strictObject({
  name: z.string(),
  url: z.string().optional().describe("Link to the check."),
});

export const contextMergeSelfSchema = z.strictObject({
  ref: z.string().min(1).describe("The office's key of the pull request."),
  number: z.number().int(),
  title: z.string(),
  url: z.string().optional().describe("Link to the pull request."),
  head: z.string().describe("Its branch."),
  base: z.string().describe("The branch it merges into."),
  draft: z.boolean(),
  approvedBy: z.array(z.string()).describe("Reviewers whose latest verdict approves it."),
  changesRequestedBy: z
    .array(z.string())
    .describe("Reviewers whose latest verdict asks for changes."),
  ci: ci.describe("Combined state of its checks on the current head."),
  failing: z.array(contextCheckSchema).describe("Its checks that failed."),
  mergeable: z.enum(["clean", "conflicting", "unknown"]),
  unresolvedThreads: z.number().int().describe("How many review threads are unresolved."),
});

export const contextMergeOtherSchema = z.strictObject({
  ref: z.string().min(1).describe("The office's key of the pull request."),
  number: z.number().int(),
  title: z.string(),
  url: z.string().optional().describe("Link to the pull request."),
  author: z.string().describe("The agent's handle, else the code host login."),
  draft: z.boolean(),
  approved: z.boolean().describe("A reviewer approved it and none asks for changes."),
  ci,
  mergeable: z.enum(["clean", "conflicting", "unknown"]),
  relation: z
    .array(z.enum(["stacked_on_it", "under_it", "same_base", "overlapping_files"]))
    .describe(
      "How it relates to this pull request: stacked on it, the one it is stacked on, into the same base branch, or changing some of the same files.",
    ),
  files: z.array(z.string()).describe("Files both change, the first few, when they overlap."),
});

export const contextMergeSchema = z.strictObject({
  pr: contextMergeSelfSchema.describe("The pull request to decide on."),
  base: z.strictObject({
    ref: z.string().describe("The base branch."),
    ci: z
      .enum(["none", "pending", "success", "failure", "unknown"])
      .describe("Combined state of the checks on the base branch's head; unknown when not read."),
    failing: z.array(contextCheckSchema).describe("Checks on the base branch that failed."),
  }),
  others: z
    .array(contextMergeOtherSchema)
    .describe(
      "The other open pull requests of the repository, related ones first, at most `pipeline.context.items`.",
    ),
  moreOthers: z.number().int().optional().describe("Other open pull requests left out."),
  recentMerges: z
    .array(
      z.strictObject({
        ref: z.string().min(1),
        number: z.number().int(),
        title: z.string(),
        url: z.string().optional().describe("Link to the pull request."),
        author: z.string(),
        at: z.string().describe("When the office last saw it, about when it merged (ISO-8601)."),
      }),
    )
    .describe("The latest pull requests merged into the base branch, latest first."),
});

export const wakeContextSchema = z.strictObject({
  tickets: z.array(contextTicketSchema),
  prs: z.array(contextPrSchema),
  docs: z.array(contextDocSchema),
  chats: z.array(contextChatSchema),
  merge: contextMergeSchema
    .optional()
    .describe(
      "For a merge: the pull request's state, the repository's other open pull requests and how they relate to it, the latest merges into its base and the base's checks.",
    ),
  omitted: z
    .number()
    .int()
    .optional()
    .describe(
      "Linked items left out by `pipeline.context.items`, the farthest from the wake first.",
    ),
});
