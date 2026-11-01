import { z } from "zod";
import { CANONICAL_STATUSES } from "#/ports/status.js";
import type { CanonicalStatus } from "#/ports/types.js";
import { HAND_BACK_STATUSES } from "./constants.js";
import type { Condition } from "./types.js";

const d = (description: string) => ({ description });

const status = z.enum(CANONICAL_STATUSES as readonly [CanonicalStatus, ...CanonicalStatus[]]);

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(conditionSchema).min(1) }).meta(d("Every condition must hold.")),
    z
      .strictObject({ any: z.array(conditionSchema).min(1) })
      .meta(d("At least one condition must hold.")),
    z.strictObject({ not: conditionSchema }).meta(d("The condition must not hold.")),
    z
      .strictObject({ ticket_status: z.array(status).min(1) })
      .meta(d("The linked ticket is in one of these canonical statuses.")),
    z
      .strictObject({ moved_to: z.array(status).min(1) })
      .meta(d("A ticket.moved event moved the ticket into one of these statuses.")),
    z
      .strictObject({ actor_kind: z.enum(["human", "agent", "automation"]) })
      .meta(d("Who caused the event.")),
    z
      .strictObject({ assignee_kind: z.enum(["human", "agent", "none"]) })
      .meta(d("Who the ticket is assigned to.")),
    z
      .strictObject({ has_label: z.string().min(1) })
      .meta(d('The ticket has this label. "$needs_human" means the configured needs-human label.')),
    z
      .strictObject({ pr_author_kind: z.enum(["human", "agent", "bot"]) })
      .meta(d("Who authored the pull request.")),
    z
      .strictObject({ approver: z.boolean() })
      .meta(
        d(
          "The actor of the event is (or is not) an allowed approver of a merge, as policies.merge.approvers says.",
        ),
      ),
    z.strictObject({ pr_draft: z.boolean() }).meta(d("The pull request is (or is not) a draft.")),
    z.strictObject({ pr_open: z.boolean() }).meta(d("The pull request is (or is not) open.")),
    z.strictObject({ pr_merged: z.boolean() }).meta(d("The pull request is (or is not) merged.")),
    z
      .strictObject({ pr_base_default: z.boolean() })
      .meta(
        d(
          "The pull request targets (or, with false, does not target) its repository's default branch (repos[].default_branch). A pull request stacked on another one's branch does not.",
        ),
      ),
    z
      .strictObject({ has_body: z.boolean() })
      .meta(
        d(
          "The review or comment in the event has (or lacks) text: a non-blank body, or for a review, inline comments.",
        ),
      ),
    z
      .strictObject({ agent_mentioned: z.boolean() })
      .meta(
        d(
          "The comment in the event mentions (or, with false, does not mention) a team agent: event.data.mentions, which the office fills with the handles of the agents a trusted person's comment names.",
        ),
      ),
    z
      .strictObject({ review_state: z.array(z.string().min(1)).min(1) })
      .meta(d('The review state in the event, for example "approved".')),
    z
      .strictObject({ hand_back_status: z.array(z.enum(HAND_BACK_STATUSES)).min(1) })
      .meta(
        d("An agent.handed_back event carries one of these statuses: done, waiting or blocked."),
      ),
    z
      .strictObject({ work_kind: z.array(z.string().min(1)).min(1) })
      .meta(
        d(
          'An agent.started or agent.handed_back event is for a work item of one of these kinds, for example "review_feedback".',
        ),
      ),
    z
      .strictObject({ pr_approved: z.boolean() })
      .meta(
        d(
          "An allowed approver (policies.merge.approvers) has approved the pull request and none has requested changes since (or, with false, that does not hold).",
        ),
      ),
    z
      .strictObject({ ticket_prs_all_closed: z.boolean() })
      .meta(
        d(
          "Every pull request linked to the ticket is closed and at least one of them is merged (or, with false, that does not hold).",
        ),
      ),
    z
      .strictObject({ ticket_prs_open: z.boolean() })
      .meta(
        d(
          "At least one pull request linked to the ticket is still open (or, with false, none is).",
        ),
      ),
    z
      .strictObject({ ticket_prs_several: z.boolean() })
      .meta(
        d(
          "The ticket has two or more pull requests that are open or merged (or, with false, fewer). Closed ones that were never merged do not count.",
        ),
      ),
    z
      .strictObject({ ticket_handed_back: z.boolean() })
      .meta(
        d(
          "The agent's latest work on the ticket ended with a hand-back as done (or, with false, did not).",
        ),
      ),
    z
      .strictObject({ blocked_agent: z.boolean() })
      .meta(
        d(
          "The ticket is blocked and an agent is blocked on it: the agent whose latest work on it was handed back as blocked (or, with false, no agent is).",
        ),
      ),
    z
      .strictObject({ actor_in_round: z.boolean() })
      .meta(
        d(
          "The actor is an agent that had a round of work on the ticket under way when the event happened; an agent's event without a time counts as in one (or, with false, is not).",
        ),
      ),
  ]),
);
