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
  })
  .default({ follow_up_round: true })
  .meta(d("How agents act on feedback from trusted people beyond the first round."));

export const handBackSchema = z
  .strictObject({
    blocked_notify: z
      .enum(["pm", "agent"])
      .default("pm")
      .meta(
        d(
          "Who tells the requester about blocked work that did not come from chat: agent has the blocked agent tell them itself, in its own direct message; pm leaves it to the team's PM, who gives the ticket to the requester, saying what is needed, only when it cannot unblock it, and the blocked agent sends nothing. Either way a blocked ticket goes to the PM to unblock when the team has one; this only decides who sends the chat message. Without a PM role the agent always does. The office never posts to people. Default pm.",
        ),
      ),
    fallback: z
      .enum(["first_human", "none"])
      .default("first_human")
      .meta(
        d(
          "Who stands in when a ticket has no known requester: the first human in humans with a tracker identity, or none to skip. Default first_human.",
        ),
      ),
  })
  .default({ blocked_notify: "pm", fallback: "first_human" })
  .meta(d("What happens to a ticket when an agent hands its work back."));

export const ticketsSchema = z
  .strictObject({
    prs_per_ticket: z
      .enum(["one", "many"])
      .default("one")
      .meta(
        d(
          "How many pull requests a ticket may have. one: ost pr open refuses a second one for a ticket; many: several are allowed. Either way the ticket moves to done when its last open pull request merges into the default branch. Default one.",
        ),
      ),
  })
  .default({ prs_per_ticket: "one" })
  .meta(d("How tickets and pull requests relate."));
