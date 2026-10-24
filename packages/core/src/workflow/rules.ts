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
  | { pr_draft: boolean }
  | { pr_open: boolean }
  | { has_body: boolean }
  | { review_state: string[] };

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
    z.strictObject({ pr_draft: z.boolean() }).meta(d("The pull request is (or is not) a draft.")),
    z.strictObject({ pr_open: z.boolean() }).meta(d("The pull request is (or is not) open.")),
    z
      .strictObject({ has_body: z.boolean() })
      .meta(d("The review or comment in the event has (or lacks) a non-blank body.")),
    z
      .strictObject({ review_state: z.array(z.string().min(1)).min(1) })
      .meta(d('The review state in the event, for example "approved".')),
  ]),
);

export type Action =
  | { move: CanonicalStatus }
  | { assign: string }
  | { comment: string | { template: string; on?: "ticket" | "pr" } }
  | { schedule: { person: string; kind: string; priority: "low" | "normal" | "high" } }
  | { notify: { to: string; template: string } };

const templateId = z.string().regex(SLUG, "Use lowercase letters, digits, dashes and underscores.");

export const actionSchema: z.ZodType<Action> = z.union([
  z.strictObject({ move: status }).meta(d("Move the ticket to a canonical status.")),
  z
    .strictObject({
      assign: z
        .string()
        .regex(
          new RegExp(`^(author|last_worker|requester|none|human:\\S+|${ROLE})$`),
          "Use author, last_worker, requester, none, human:<id> or role:<role>.",
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
            new RegExp(`^(author|assignee|last_worker|${ROLE})$`),
            "Use author, assignee, last_worker or role:<role>.",
          ),
        kind: z.string().regex(SLUG, "Use lowercase letters, digits, dashes and underscores."),
        priority: z.enum(["low", "normal", "high"]).default("normal"),
      }),
    })
    .meta(d("Schedule a work item for an agent.")),
  z
    .strictObject({
      notify: z.strictObject({
        to: z
          .string()
          .regex(
            /^(requester|assignee|channel(:\S+)?)$/,
            "Use requester, assignee, channel or channel:<name>.",
          ),
        template: templateId,
      }),
    })
    .meta(d("Send a rendered template to a person or channel.")),
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
