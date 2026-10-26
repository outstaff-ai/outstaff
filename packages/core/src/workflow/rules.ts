import { z } from "zod";
import { CANONICAL_STATUSES, type CanonicalStatus } from "../ports/status.js";
import { WORKFLOW_EVENT_TYPES, type WorkflowEventType } from "./types.js";

const d = (description: string) => ({ description });

const status = z.enum(CANONICAL_STATUSES as readonly [CanonicalStatus, ...CanonicalStatus[]]);
const SLUG = /^[a-z][a-z0-9_-]*$/;
const ROLE = "role:[a-z][a-z0-9-]*";

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { ticket_status: CanonicalStatus[] }
  | { moved_to: CanonicalStatus[] }
  | { actor_kind: "human" | "agent" | "automation" }
  | { assignee_kind: "human" | "agent" | "none" }
  | { has_label: string }
  | { pr_author_kind: "human" | "agent" | "bot" }
  | { approver: boolean }
  | { pr_draft: boolean }
  | { pr_open: boolean }
  | { pr_merged: boolean }
  | { has_body: boolean }
  | { agent_mentioned: boolean }
  | { review_state: string[] }
  | { hand_back_status: HandBackStatus[] }
  | { hand_back_kind: string[] }
  | { pr_approved: boolean }
  | { ticket_prs_all_closed: boolean }
  | { ticket_prs_open: boolean }
  | { ticket_prs_several: boolean }
  | { ticket_handed_back: boolean };

/** How an agent ended its turn on a work item: finished, waiting for an answer, or unable to continue. */
export const HAND_BACK_STATUSES = ["done", "waiting", "blocked"] as const;
export type HandBackStatus = (typeof HAND_BACK_STATUSES)[number];

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
      .strictObject({ hand_back_kind: z.array(z.string().min(1)).min(1) })
      .meta(
        d(
          'An agent.handed_back event is for a work item of one of these kinds, for example "review_feedback".',
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
  ]),
);

export type Action =
  | { move: CanonicalStatus }
  | { assign: string }
  | { comment: string | { template: string; on?: "ticket" | "pr" } }
  | { schedule: { person: string; kind: string; priority: "low" | "normal" | "high" } };

const templateId = z.string().regex(SLUG, "Use lowercase letters, digits, dashes and underscores.");

export const actionSchema: z.ZodType<Action> = z.union([
  z.strictObject({ move: status }).meta(d("Move the ticket to a canonical status.")),
  z
    .strictObject({
      assign: z
        .string()
        .regex(
          new RegExp(`^(author|last_worker|requester|mentioned|none|human:\\S+|${ROLE})$`),
          "Use author, last_worker, requester, mentioned, none, human:<id> or role:<role>.",
        )
        .meta(d("Assign the ticket.")),
    })
    .meta(d("Assign the ticket.")),
  z
    .strictObject({
      comment: z.union([
        templateId,
        z.strictObject({ template: templateId, on: z.enum(["ticket", "pr"]).optional() }),
      ]),
    })
    .meta(d("Post a rendered template as a comment (on the ticket by default).")),
  z
    .strictObject({
      schedule: z.strictObject({
        person: z
          .string()
          .regex(
            new RegExp(
              `^(author|assignee|last_worker|doc_author|mentioned|other_mentioned|${ROLE})$`,
            ),
            "Use author, assignee, last_worker, doc_author, mentioned, other_mentioned or role:<role>.",
          ),
        kind: z.string().regex(SLUG, "Use lowercase letters, digits, dashes and underscores."),
        priority: z.enum(["low", "normal", "high"]).default("normal"),
      }),
    })
    .meta(d("Schedule a work item for an agent.")),
]) as z.ZodType<Action>;

const eventType = z.enum(WORKFLOW_EVENT_TYPES);
const ruleId = z
  .string()
  .regex(SLUG, "Use lowercase letters, digits, dashes and underscores.")
  .max(64);

export const ruleSchema = z
  .strictObject({
    id: ruleId.meta(d("Unique id. A rule with the same id as a preset rule replaces it.")),
    on: z
      .union([eventType, z.array(eventType).min(1)])
      .meta(d("Event type or types that trigger the rule.")),
    if: conditionSchema.optional().meta(d("Condition that must hold.")),
    do: z.array(actionSchema).min(1).meta(d("Actions, run in order.")),
    disabled: z.boolean().optional().meta(d("Set to true to remove the rule.")),
  })
  .meta(d("A workflow rule."));

export const ruleDisableSchema = z
  .strictObject({ id: ruleId, disabled: z.literal(true) })
  .meta(d("Removes the preset rule with this id."));

/** One entry of `workflow.rules` as written in team.yaml. */
export const ruleInputSchema = z.union([ruleSchema, ruleDisableSchema]);

export type Rule = {
  id: string;
  on: WorkflowEventType | WorkflowEventType[];
  if?: Condition | undefined;
  do: Action[];
  disabled?: boolean | undefined;
};

export type RuleInput = Rule | { id: string; disabled: true };
