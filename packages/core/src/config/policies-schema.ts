import { z } from "zod";
import { teamCommandsSchema } from "../permissions/schema.js";
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
    conflicts: z
      .strictObject({
        follow_up: z
          .boolean()
          .default(true)
          .meta(
            d(
              "Send a pull request that starts to conflict with its base, for example after another one merged, back to its agent author to rebase. Switches the preset rule conflict-back-to-author. Default on.",
            ),
          ),
      })
      .default({ follow_up: true })
      .meta(d("Merge conflicts between pull requests.")),
    retry: z
      .strictObject({
        on_signal: z
          .boolean()
          .default(true)
          .meta(
            d(
              "Retry a blocked work item when a trusted human moves its ticket, assigns it, reviews or comments on its pull request, or replies in its chat thread. Default on.",
            ),
          ),
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
      .default({ on_signal: true, base_minutes: 1, cap_minutes: 30, max_failures: 3 })
      .meta(
        d(
          "How a failing work item is retried: exponential backoff, then blocked; and whether a human's signal brings a blocked item back.",
        ),
      ),
    merge: z
      .strictObject({
        on_approval: z
          .boolean()
          .default(false)
          .meta(
            d(
              "Let an agent merge its own pull request, with ost pr merge, when an allowed approver approves it. Off by default: without it the verb refuses and nothing is scheduled. Adds the preset rules approved-merge and approved-merge-after-feedback. Needs a vcs adapter with vcs.merge. It never bypasses branch protection or rulesets; the code host stays the final gate.",
            ),
          ),
        approvers: z
          .array(z.string().regex(APPROVER, "Use humans, human:<id>, role:<role> or a handle."))
          .min(1)
          .default(["humans"])
          .meta(
            d(
              "Who may approve a merge: humans (the people in humans, or anyone with write access when humans is omitted), human:<id> (one human, by vcs identity), role:<role> (the agent playing a catalog role) or a handle (an agent, or a human by vcs login). Default humans.",
            ),
          ),
        method: z
          .enum(["queue", "merge", "squash"])
          .optional()
          .meta(
            d(
              "How the pull request is merged: queue (the host's merge queue), merge or squash. When omitted, outstaff uses what the repository has: its merge queue, else a method its settings allow.",
            ),
          ),
        repos: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .meta(
            d(
              "Names of the repos (from repos) whose pull requests may be merged this way. Default: every repo an agent can write to.",
            ),
          ),
      })
      .default({ on_approval: false, approvers: ["humans"] })
      .meta(d("Merging an agent's pull request when an allowed approver approves it (opt-in).")),
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
  })
  .meta(d("Team-wide guardrails, message style and switches for what outstaff does on its own."));
