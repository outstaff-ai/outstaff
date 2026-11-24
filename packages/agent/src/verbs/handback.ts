import { PortError } from "@outstaff/core";
import { z } from "zod";
import { defineVerb, result } from "./define.js";

export const handBack = defineVerb({
  name: "handback",
  summary: "Say how the work item ends when this round stops, and what to tell the human.",
  description:
    "States the hand-back of the work item you are on; the last one you state counts, with its message. --message is your short message for the human the work goes to: what changed since they last looked, and what you need from them, in your own words. Leave out how you worked (that you handed back, pushed, or ran the checks). The chat notice that gives them the work leads with it, the ticket and pull request linked after it; without it, the notice leads with your final message. done: there is a result to review (a pull request open for review, a document linked, the ticket moved to review with your answer) or the work is finished (the ticket closed); a round that leaves none is not done. blocked: nothing more can be done until someone decides or answers (a human or a teammate, even one who already has the question, or a sub-ticket that is itself blocked), or anything else outside your control; say what and from whom in a comment first, and lead the message with the ticket and what is needed from whom, never 'I am blocked'. silent: the round needed nothing handed on (a comment or mention that asks nothing of you, a merge that waits, a ticket that waits on a human's review or on sub-tickets in review or with an agent); the ticket is put back as the round found it, and is not given to you again until someone else acts on it. Waiting on a review is not blocked; waiting on an answer is. A second silent hand-back of a ticket nobody else acted on since is taken as blocked. Work on a ticket finishes silently only while everything open on it is in flight (its pull requests open for review, its sub-tickets in review or with an agent); the office takes any other as blocked, and a blocked hand-back on such a ticket as silent. Without it, a round with a result is done, a round of those kinds without one is silent, and any other is told it has nothing to review. To wait for another agent, ask it with ost ask instead.",
  input: z.strictObject({
    status: z.enum(["done", "blocked", "silent"]).describe("How the work item ends."),
    message: z
      .string()
      .trim()
      .min(1)
      .max(100_000)
      .optional()
      .describe(
        "Your message for the human the work goes to: what changed since they last looked and what you need from them.",
      ),
  }),
  args: ["status"],
  examples: [
    'ost handback done --message "Addressed the review on acme/app#70: own preview step and top-level env. Answered the question about caching without a change."',
    'ost handback blocked --message "ACME-98 needs one of these from you: the staging key, or a go-ahead to mock the payment service."',
    "ost handback silent",
  ],
  async run(env, input) {
    const item = env.handBack;
    if (!item) {
      throw new PortError("invalid", "Only a work item hands back; there is none here.");
    }

    item.declare(input.status, input.message);
    return result(
      [
        `The item is handed back as ${input.status} when the round ends${input.message ? ", with your message" : ""}.`,
      ],
      { status: input.status, ...(input.message ? { message: input.message } : {}) },
      [],
    );
  },
});
