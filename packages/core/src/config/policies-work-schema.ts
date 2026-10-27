import { z } from "zod";
import { CONFIG_CODES } from "./codes.js";
import { customIssue } from "./issues.js";
import { d } from "./schema-meta.js";

export const agentLoopGuardSchema = z
  .strictObject({
    max_runs_per_item_per_hour: z
      .int()
      .min(1)
      .default(12)
      .meta(
        d(
          "Maximum runs per work item per hour triggered by agents or automation; humans are never limited.",
        ),
      ),
  })
  .default({ max_runs_per_item_per_hour: 12 })
  .meta(
    d(
      "Stops agents from triggering each other in endless loops. Limits only runs triggered by agents or automation; humans are never limited.",
    ),
  );

export const usageSchema = z
  .strictObject({
    defer_scheduled_at: z
      .number()
      .min(0)
      .max(1)
      .default(0.85)
      .meta(d("Fraction of the usage limit at which scheduled work is deferred.")),
    pause_automatic_at: z
      .number()
      .min(0)
      .max(1)
      .default(0.95)
      .meta(d("Fraction of the usage limit at which all automatic work pauses.")),
    shared: z
      .array(z.array(z.string().min(1)).min(2))
      .optional()
      .meta(
        d(
          "Groups of people who use one LLM subscription, as lists of handles. A usage report from any member applies to all of them.",
        ),
      ),
  })
  .superRefine((v, ctx) => {
    if (v.defer_scheduled_at > v.pause_automatic_at) {
      ctx.addIssue(
        customIssue(
          CONFIG_CODES.usageThresholdOrder,
          "defer_scheduled_at must not exceed pause_automatic_at.",
          ["defer_scheduled_at"],
        ),
      );
    }
  })
  .default({ defer_scheduled_at: 0.85, pause_automatic_at: 0.95 })
  .meta(d("Thresholds that slow down work as the LLM usage limit approaches."));

export const acknowledgeSchema = z
  .strictObject({
    chat: z
      .boolean()
      .default(true)
      .meta(
        d(
          "React with eyes to a chat message from a trusted person when the agent has seen it. Default on.",
        ),
      ),
    vcs: z
      .boolean()
      .default(true)
      .meta(
        d(
          "React with eyes to each pull request comment the agent is about to answer, when its round starts. Needs a vcs adapter with vcs.reactions. Default on.",
        ),
      ),
  })
  .default({ chat: true, vcs: true })
  .meta(d("The reactions that show people their message or comment was picked up."));

export const feedbackSchema = z
  .strictObject({
    follow_up_round: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Start another round when feedback arrived after the agent was offered its work. Default on.",
        ),
      ),
    merged_prs: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Schedule the author to answer feedback on a merged pull request. Switches the preset rule merged-feedback-follow-up. Default on.",
        ),
      ),
    doc_comments: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Schedule the author of a knowledge document to answer a trusted person's comments on it. Switches the preset rule doc-feedback-to-author. Default on.",
        ),
      ),
    ticket_comments: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Start a round for the assigned agent when a trusted person comments on its ticket, and send a handed-back ticket back to its last worker. Switches the preset rules ticket-comment-to-assignee and ticket-comment-reactivates-ticket. Default on.",
        ),
      ),
    mentions: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Hand a ticket to the agent a trusted person mentions in a comment on it (assign, move to active, start a round), and start a round for an agent mentioned in a document comment. Switches the preset rules mention-assigns-agent, doc-mention-feedback and doc-mention-assigns-ticket. Default on.",
        ),
      ),
  })
  .default({
    follow_up_round: true,
    merged_prs: true,
    doc_comments: true,
    ticket_comments: true,
    mentions: true,
  })
  .meta(d("How agents act on feedback from trusted people beyond the first round."));

export const handBackSchema = z
  .strictObject({
    reassign: z
      .enum(["requester", "none"])
      .default("requester")
      .meta(
        d(
          "Who an agent's hand-back assigns the ticket to: the requester, or none to leave the assignee alone (the ticket still moves: to review when done, to blocked when blocked). Edits the preset rules hand-back-to-requester and hand-back-blocked-to-requester. Default requester.",
        ),
      ),
    blocked_notify: z
      .enum(["pm", "agent"])
      .default("pm")
      .meta(
        d(
          "Who deals with a blocked hand-back: pm schedules an unblock round for the team's PM, who messages the requester only if a human is needed; agent has the blocked agent tell the requester itself, in its own direct message. Without a PM role the agent always does. The office never posts to people. Default pm.",
        ),
      ),
    fallback: z
      .enum(["first_human", "none"])
      .default("first_human")
      .meta(
        d(
          "Who stands in when a ticket has no known requester: the first human in humans, or none to skip. Default first_human.",
        ),
      ),
  })
  .default({ reassign: "requester", blocked_notify: "pm", fallback: "first_human" })
  .meta(d("What happens to a ticket when an agent hands its work back."));

export const ticketsSchema = z
  .strictObject({
    prs_per_ticket: z
      .enum(["one", "many"])
      .default("one")
      .meta(
        d(
          "How many pull requests a ticket may have. one: ost pr open refuses a second one for a ticket and the ticket moves to done when its pull request merges; many: several are allowed and the ticket moves to done when the agent hands its work back as done and every pull request linked to it is closed with at least one merged. Edits the preset rules pr-merged-done, pr-closed-ready, hand-back-to-requester and second-pr-comment. Default one.",
        ),
      ),
    start_moves_active: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Move a ticket to active when a work item about it starts (assigned, ticket comment), if it is in backlog, ready, review or blocked. Rounds that only answer something (asked, document feedback) and chat sessions never move it, and the minimal preset never moves tickets. Default on.",
        ),
      ),
  })
  .default({ prs_per_ticket: "one", start_moves_active: true })
  .meta(d("How tickets and pull requests relate."));
