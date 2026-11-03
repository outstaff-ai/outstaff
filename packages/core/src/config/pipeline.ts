import { z } from "zod";
import { conditionSchema } from "#/workflow/condition-schema.js";

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
    reviews: z
      .int()
      .min(0)
      .max(50)
      .optional()
      .meta(
        d(
          "The latest review comments on the pull requests of the ticket being worked on and of its parent, resolved and merged ones included. Default 10.",
        ),
      ),
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
      .meta(d("Changes to the built-in and custom policies, by policy id.")),
    wake: z
      .strictObject({
        coalesce_seconds: z
          .int()
          .min(0)
          .max(3600)
          .optional()
          .meta(
            d(
              "Wakes for the same person and subject within this many seconds of the first become one run, which starts when the window closes. A chat message is answered at once: its wake waits for no window, though a message for a session still queued joins it. Default 60; 0 turns it off.",
            ),
          ),
      })
      .optional()
      .meta(d("How wakes are batched.")),
    notify: z
      .strictObject({
        debounce_seconds: z
          .int()
          .min(0)
          .max(3600)
          .optional()
          .meta(
            d(
              "How long a direct message to a human about work that landed on them (the notify_human_on_handoff policy) waits for more to join it: an agent's messages to one human within this many seconds of the latest go as one. A message also waits while the agent's round on its ticket runs, so a pull request opened in a round goes with the round's hand-back. Default 60, or office.poll_interval_seconds plus 15 when that is longer, so a pull request the office reads after the hand-back still joins its message.",
            ),
          ),
      })
      .optional()
      .meta(
        d("How the direct messages that tell a human about work that landed on them are batched."),
      ),
    context: pipelineContextSchema.optional(),
  })
  .meta(
    d(
      "The event pipeline, which decides what the office does with every event (decision 0018): changes to its default policies, how wakes are batched, and the context every wake carries.",
    ),
  );
