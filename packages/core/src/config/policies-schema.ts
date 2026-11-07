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
    notify_handoff: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Have an agent tell a human in a direct message in chat when work lands on them: a ticket it hands back to them for review, a blocked ticket given to them (a PM that cannot unblock it, for example), or a pull request it opens for their review. The message leads with the agent's own words for the human from its hand-back, whole, then says what is needed and links the pull requests and the ticket they are for. One agent's messages to one human are batched (pipeline.notify.debounce_seconds), and a review notice waits for the checks on its pull requests' heads to pass (only the required ones, when the repository requires any): nothing is sent when they fail. A ticket whose work is tied to a chat thread of the agent with that human is told as a reply in that thread instead, and nothing is sent for a round that put nothing new in front of them. A human with no identities.chat is sent nothing, and the office logs it. Default on.",
        ),
      ),
    pull_ready: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Let an agent with nothing queued or running start its next ready ticket: assigned to it, in the ready status, highest tracker priority first, then the one ready the longest. Counts as automatic work. Default on.",
        ),
      ),
    recheck_blocked: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Wake the PM on a blocked ticket when something it may wait on happened: a check that failed on the merge commit of its pull request passes on a later commit of the default branch while its work goes on, one of several tickets linked as its blockers closes, or the human it is assigned to writes about it on another ticket. The PM checks whether the block still holds, and unblocks or closes the ticket with a comment when it does not. At most once per ticket and cause in 24 hours. Default on.",
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
              "Let agents merge their own approved pull requests. When an agent's pull request may be ready to merge (an allowed approver approves it with its checks green, its checks turn green while it is approved, or the pull request it was stacked on merges), the office wakes its author to decide: merge it with ost pr merge, wait, or coordinate first. ost pr merge checks the approvals and the required checks, and where the repository has a merge queue merging means joining it. Off by default: no one is woken to merge, ost pr merge refuses, and people merge. Needs a vcs adapter with vcs.merge.",
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
              "How ost pr merge merges: queue (the host's merge queue), merge or squash. When omitted, outstaff uses what the repository has: its merge queue, else a method its settings allow.",
            ),
          ),
        repos: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .meta(
            d(
              "Names of the repos (from repos) whose pull requests agents may merge, and are woken to merge. Default: every repo an agent can write to.",
            ),
          ),
      })
      .default({ on_approval: false, approvers: ["humans"] })
      .meta(
        d(
          "Agents merging their own approved pull requests, each merge their decision, woken when a pull request may be ready (opt-in).",
        ),
      ),
    merge_checks: z
      .strictObject({
        wait_for_start_minutes: z
          .number()
          .positive()
          .max(1440)
          .default(5)
          .meta(
            d(
              "Minutes the office waits for a check to appear on a merge commit. With none by then, the merge counts as passed and its ticket can close. Fractions are allowed. Default 5.",
            ),
          ),
        timeout_minutes: z
          .number()
          .positive()
          .max(10_080)
          .default(120)
          .meta(
            d(
              "Minutes after the merge after which a check still running on the merge commit counts as failed, naming that check. Fractions are allowed. Default 120.",
            ),
          ),
        settle_minutes: z
          .number()
          .min(0)
          .max(1440)
          .default(2)
          .meta(
            d(
              "Minutes the checks on a merge commit must stay finished, with none failed and no new one appearing, before the merge counts as passed, so a workflow that starts after the first ones finish is still waited for. Fractions are allowed. Default 2.",
            ),
          ),
      })
      .default({ wait_for_start_minutes: 5, timeout_minutes: 120, settle_minutes: 2 })
      .meta(
        d(
          "The checks that run on a pull request's merge commit in the default branch, such as a deploy. A ticket closes only once they pass; when one fails, the author is woken with its log.",
        ),
      ),
    reconcile: z
      .strictObject({
        every: z
          .union([z.literal("off"), z.string().regex(/^\d+(\.\d+)?[mh]$/)])
          .default("2h")
          .meta(
            d(
              "How often the office sweeps the open tickets in active, review and blocked for ones whose status or assignee no longer matches what it knows, and wakes the PM with the list when it finds any: minutes (`30m`) or hours (`2h`), fractions allowed, or `off`. Default 2h.",
            ),
          ),
        stale_hours: z
          .number()
          .positive()
          .max(8760)
          .default(48)
          .meta(
            d(
              "Hours a blocked ticket assigned to a human may go without a change in the tracker before the sweep lists it. Default 48.",
            ),
          ),
      })
      .default({ every: "2h", stale_hours: 48 })
      .meta(
        d(
          "The periodic board sweep: the office checks each open ticket against the facts it has (pull requests merged, blockers closed, no work running) and wakes the PM only when one disagrees, with the facts for each.",
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
              "Let roles that declare the design.canvas capability use Claude's Artifact tools (the Design canvas), and roles that declare design.canvas.read read those canvases. Needs the claude-agent-sdk runtime signed in with a Claude account. Default on; it does nothing for a role without either capability.",
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
        catch_up_hours: z
          .int()
          .min(0)
          .max(168)
          .default(24)
          .meta(
            d(
              "How far back an agent picks up the chat messages written to it while it was offline, when its chat connects: each is taken as if it had just arrived, oldest first, up to 10 per conversation. Anything older, or beyond the 10, is not picked up, and the agent says so once in that conversation. 0 turns catching up off. Needs a chat adapter with chat.catchUp. Default 24.",
            ),
          ),
      })
      .default({ parallel_sessions: 2, profile: true, catch_up_hours: 24 })
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
