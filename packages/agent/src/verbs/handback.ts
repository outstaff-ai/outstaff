import { PortError, SILENT_KINDS } from "@outstaff/core";
import { z } from "zod";
import { defineVerb, result } from "./define.js";

export const handBack = defineVerb({
  name: "handback",
  summary: "Say how the work item ends when this round stops: done, blocked or silent.",
  description:
    "States the hand-back of the work item you are on; the last one you state counts. done: there is a result to review (a pull request open for review, a document linked, the ticket moved to review with your answer) or the work is finished (the ticket closed); a round that leaves none is not done. blocked: you need a decision or an answer from a human, or anything outside your control; say what and from whom in a comment first. silent: the round needed nothing handed on (a comment or mention that asks nothing of you, a merge that waits); the ticket is put back as the round found it. Only rounds of comments, mentions, questions, chat, reviews, merges and pull request upkeep may finish silently. Without it, a round with a result is done, a round of those kinds without one is silent, and any other is told it has nothing to review. To wait for another agent, ask it with ost ask instead.",
  input: z.strictObject({
    status: z.enum(["done", "blocked", "silent"]).describe("How the work item ends."),
  }),
  args: ["status"],
  examples: ["ost handback blocked", "ost handback silent"],
  async run(env, input) {
    const item = env.handBack;
    if (!item) {
      throw new PortError("invalid", "Only a work item hands back; there is none here.");
    }

    if (input.status === "silent" && !SILENT_KINDS.includes(item.kind)) {
      throw new PortError(
        "invalid",
        `A ${item.kind} item cannot finish silently: hand back done with a result to review, or blocked.`,
      );
    }

    item.declare(input.status);
    return result(
      [`The item is handed back as ${input.status} when the round ends.`],
      { status: input.status },
      [],
    );
  },
});
