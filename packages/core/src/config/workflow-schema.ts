import { z } from "zod";
import { ruleInputSchema } from "../workflow/rules.js";
import { d } from "./schema-meta.js";

const STATUSES = ["backlog", "ready", "active", "review", "blocked", "done", "canceled"] as const;

export const workflowSchema = z
  .strictObject({
    preset: z
      .enum(["kanban", "scrum", "minimal"])
      .default("kanban")
      .meta(d("Built-in workflow to start from.")),
    statuses: z
      .partialRecord(z.enum(STATUSES), z.string().min(1))
      .optional()
      .meta(d("Maps canonical statuses to the status names used in your tracker.")),
    rules: z
      .array(ruleInputSchema)
      .optional()
      .meta(
        d(
          "Rules added to the preset. A rule with a preset rule's id replaces it; { id, disabled: true } removes it.",
        ),
      ),
    templates: z
      .record(z.string().regex(/^[a-z][a-z0-9_-]*$/), z.string().min(1))
      .optional()
      .meta(
        d(
          "Comment and notification templates by id, with {{variable}} placeholders. They override built-in templates with the same id.",
        ),
      ),
    needs_human_label: z
      .string()
      .min(1)
      .optional()
      .meta(d('Ticket label that keeps work with a human. Default "needs-human".')),
  })
  .meta(d("How work moves through the team."));
