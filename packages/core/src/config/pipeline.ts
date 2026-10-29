import { z } from "zod";
import { conditionSchema } from "#/workflow/rules.js";

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

/** How much of what the office knows goes with each wake. */
export const pipelineContextSchema = z
  .strictObject({
    comments: z
      .int()
      .min(0)
      .max(50)
      .optional()
      .meta(d("The latest comments of each ticket handed over. Default 5.")),
    messages: z
      .int()
      .min(0)
      .max(50)
      .optional()
      .meta(d("The latest messages of each chat thread handed over. Default 10.")),
    threads: z
      .int()
      .min(0)
      .max(50)
      .optional()
      .meta(d("The unresolved review threads of each pull request handed over. Default 5.")),
    items: z
      .int()
      .min(1)
      .max(50)
      .optional()
      .meta(
        d(
          "How many tickets, pull requests, documents and chat threads one wake carries at most, the closest to what woke the agent first. Default 8.",
        ),
      ),
    body_chars: z
      .int()
      .min(100)
      .max(20_000)
      .optional()
      .meta(
        d(
          "Longer descriptions, comments and messages are cut to this many characters; the link has the rest. Default 1500.",
        ),
      ),
  })
  .meta(
    d(
      "The context bundle every wake carries: the tickets, pull requests and chat threads the work is linked to, with their recent comments, threads and messages.",
    ),
  );

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
              "Wakes for the same person and subject within this many seconds of the first become one run, which starts when the window closes (office.pipeline: live). Default 60; 0 turns it off.",
            ),
          ),
      })
      .optional()
      .meta(d("How wakes are batched.")),
    context: pipelineContextSchema.optional(),
  })
  .meta(
    d(
      "Proposed (decision 0016): the event pipeline's policies, read in the office's shadow and live modes (office.pipeline), and the context every wake carries, in every mode.",
    ),
  );
