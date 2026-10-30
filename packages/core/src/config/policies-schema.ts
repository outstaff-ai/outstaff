import { z } from "zod";
import { teamCommandsSchema } from "#/permissions/schema.js";
import { CONFIG_CODES } from "./codes.js";
import { customIssue } from "./issues.js";
import {
  acknowledgeSchema,
  agentLoopGuardSchema,
  feedbackSchema,
  handBackSchema,
  ticketsSchema,
  usageSchema,
} from "./policies-work-schema.js";
import { d } from "./schema-meta.js";

const settings = z
  .record(z.string(), z.unknown())
  .optional()
  .meta(d("Values the policy reads as `ctx.settings`; what it accepts is up to the policy."));

/** One custom policy: a module of the team's repository, or an npm package. */
const customPolicySchema = z
  .union([
    z.strictObject({
      module: z
        .string()
        .min(1)
        .meta(
          d("Path of the module, relative to this file, for example ./policies/release-freeze.ts."),
        ),
      settings,
    }),
    z.strictObject({
      package: z
        .string()
        .min(1)
        .meta(d("Name of an installed npm package, for example @acme/outstaff-policy-oncall.")),
      settings,
    }),
  ])
  .meta(d("A custom policy to load: `module` or `package`, and its settings."));

/** `humans`, `human:<id>`, `role:<role>` or an agent or login handle. */
const APPROVER = /^(humans|human:\S+|role:[a-z][a-z0-9-]*|[A-Za-z0-9][A-Za-z0-9._[\]-]*)$/;

export const policiesSchema = z
  .strictObject({
    agent_loop_guard: agentLoopGuardSchema,
    usage: usageSchema,
    acknowledge: acknowledgeSchema,
    feedback: feedbackSchema,
    hand_back: handBackSchema,
    tickets: ticketsSchema,
    pull_ready: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Let an agent with nothing queued or running start its next ready ticket: assigned to it, in the ready status, highest tracker priority first, then the one ready the longest. Counts as automatic work. Default on.",
        ),
      ),
    retry: z
      .strictObject({
        base_minutes: z
          .int()
          .min(1)
          .default(1)
          .meta(d("Wait after the first failed run of a work item; doubles with each failure.")),
        cap_minutes: z
          .int()
          .min(1)
          .default(30)
          .meta(d("Longest wait between two attempts at a failing work item.")),
        max_failures: z
          .int()
          .min(1)
          .default(3)
          .meta(d("Consecutive failed runs after which the work item is blocked.")),
      })
      .superRefine((v, ctx) => {
        if (v.base_minutes > v.cap_minutes) {
          ctx.addIssue(
            customIssue(
              CONFIG_CODES.retryBackoffOrder,
              "base_minutes must not exceed cap_minutes.",
              ["base_minutes"],
            ),
          );
        }
      })
      .default({ base_minutes: 1, cap_minutes: 30, max_failures: 3 })
      .meta(d("How a failing work item is retried: exponential backoff, then blocked.")),
    merge: z
      .strictObject({
        on_approval: z
          .boolean()
          .default(false)
          .meta(
            d(
              "Let agents turn on the code host's auto-merge on their pull requests. When an agent marks a pull request ready for review (or opens it ready), the verb also turns on auto-merge, or adds it to the merge queue where the repository has one; the repository's rules (required approvals and checks) then decide when it merges, with the repository's merge method. No agent run and no office identity merges. Also allows ost pr merge. Off by default: nothing is turned on and people merge. Needs a vcs adapter with vcs.merge.",
            ),
          ),
        approvers: z
          .array(z.string().regex(APPROVER, "Use humans, human:<id>, role:<role> or a handle."))
          .min(1)
          .default(["humans"])
          .meta(
            d(
              "Who may approve a merge with ost pr merge: humans (the people in humans, or anyone with write access when humans is omitted), human:<id> (one human, by vcs identity), role:<role> (the agent playing a catalog role) or a handle (an agent, or a human by vcs login). Default humans.",
            ),
          ),
        method: z
          .enum(["queue", "merge", "squash"])
          .optional()
          .meta(
            d(
              "How ost pr merge merges: queue (the host's merge queue), merge or squash. Auto-merge always uses the repository's own method. When omitted, outstaff uses what the repository has: its merge queue, else a method its settings allow.",
            ),
          ),
        repos: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .meta(
            d(
              "Names of the repos (from repos) whose pull requests agents may set to merge. Default: every repo an agent can write to.",
            ),
          ),
      })
      .default({ on_approval: false, approvers: ["humans"] })
      .meta(
        d(
          "Merging agents' pull requests through the code host's auto-merge or merge queue, gated by the repository's own rules (opt-in).",
        ),
      ),
    messages: z
      .strictObject({
        max_lines: z
          .int()
          .min(1)
          .max(20)
          .default(3)
          .meta(
            d(
              "Guidance for agents: keep chat replies to about this many lines. It is a hard limit only for the office's own automatic notices (status lines, run notifications). An agent's reply is never cut; one over a high safety cap is split into several messages.",
            ),
          ),
        always_link: z
          .boolean()
          .default(true)
          .meta(d("Link tickets, pull requests and documents instead of mentioning bare ids.")),
        omit: z
          .array(z.enum(["ci", "mergeability", "hashes", "file_lists"]))
          .default(["ci", "mergeability", "hashes"])
          .meta(d("Details left out of chat messages.")),
      })
      .default({ max_lines: 3, always_link: true, omit: ["ci", "mergeability", "hashes"] })
      .meta(d("How agents write chat messages.")),
    design: z
      .strictObject({
        canvas: z
          .boolean()
          .default(true)
          .meta(
            d(
              "Let roles that declare the design.canvas capability use Claude's Artifact tools (the Design canvas). Needs the claude-agent-sdk runtime signed in with a Claude account. Default on; it does nothing for a role without the capability.",
            ),
          ),
      })
      .default({ canvas: true })
      .meta(d("What design roles may use.")),
    chat: z
      .strictObject({
        parallel_sessions: z
          .int()
          .min(1)
          .max(10)
          .default(2)
          .meta(
            d(
              "How many chat sessions an agent runs at once, beside its active work item. A message beyond that waits for a free session.",
            ),
          ),
        profile: z
          .boolean()
          .default(true)
          .meta(
            d(
              "Publish the agent's profile in chat: role, status, and current work grouped by ticket or pull request. Needs a chat adapter with chat.agentProfile. Default on.",
            ),
          ),
      })
      .default({ parallel_sessions: 2, profile: true })
      .meta(d("How agents take chat messages, and what they show in chat.")),
    commands: teamCommandsSchema.optional(),
    custom: z
      .array(customPolicySchema)
      .optional()
      .meta(
        d(
          "Event pipeline policies of the team's own, which run after the built-in ones: each a module of the team's repository or an npm package that exports `policy` (or a `policies` list). They run in the office process, as trusted as this repository. `ost validate` and the office load and check each one.",
        ),
      ),
  })
  .meta(d("Team-wide guardrails, message style and switches for what outstaff does on its own."));
