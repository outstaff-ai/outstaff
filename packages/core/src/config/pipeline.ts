import { z } from "zod";
import { conditionSchema } from "../workflow/rules.js";

const d = (description: string) => ({ description });

/** A policy id of the office's event pipeline, for example `review_to_author`. */
const POLICY_ID = /^[a-z][a-z0-9_]*$/;

export const pipelinePolicySchema = z
  .strictObject({
    enabled: z
      .boolean()
      .optional()
      .meta(d("Set to false to turn the policy off. Default: the policy's own default.")),
    instruction: z
      .string()
      .min(1)
      .optional()
      .meta(
        d(
          "The instruction a woken agent is given, with {{variable}} placeholders. Replaces the policy's default text.",
        ),
      ),
    when: conditionSchema
      .optional()
      .meta(d("An extra condition that must hold as well: narrows the policy, never widens it.")),
  })
  .meta(d("Changes to one policy of the event pipeline."));

export const pipelineSchema = z
  .strictObject({
    policies: z
      .record(
        z.string().regex(POLICY_ID, "Use lowercase letters, digits and underscores."),
        pipelinePolicySchema,
      )
      .optional()
      .meta(d("Changes to the default policies, by policy id.")),
    wake: z
      .strictObject({
        coalesce_seconds: z
          .int()
          .min(0)
          .max(3600)
          .optional()
          .meta(
            d(
              "Wakes for the same person and subject within this many seconds become one run. Default 60; 0 turns it off.",
            ),
          ),
      })
      .optional()
      .meta(d("How wakes are batched.")),
  })
  .meta(
    d(
      "Proposed (decision 0016): the event pipeline's policies. Read only by the office's shadow mode (office.pipeline: shadow), which records what the pipeline would decide and changes nothing.",
    ),
  );
