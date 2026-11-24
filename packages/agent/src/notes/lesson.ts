import type { Feedback } from "@outstaff/protocol";
import type { Lessons } from "./types.js";

/** The feedback in which a human teaches or corrects: what they wrote on a pull request, a ticket or a document. */
const TAUGHT_IN = new Set<Feedback["kind"]>([
  "review",
  "comment",
  "inline_comment",
  "ticket_comment",
  "doc_comment",
]);

/** The trusted humans whose comments or reviews the round's feedback carries, each once, in order. */
export const teachers = (feedback: readonly Feedback[]): string[] => [
  ...new Set(
    feedback.filter((f) => f.from === "human" && TAUGHT_IN.has(f.kind)).map((f) => f.actor),
  ),
];

/** What `ost handback` answers, once, in a round a trusted human commented on or reviewed and no note changed. */
export const lessonRefusal = (from: readonly string[]) =>
  `Not handed back yet: this round's feedback has comments or reviews by ${from.join(", ")} (trusted), and no note changed. If they taught you anything lasting (a standing rule, a preference, how something works that the repository does not say), keep it with \`ost note add\` or \`ost note update\` (references/memory.md), then hand back again. If there is nothing to keep, hand back again with --nothing-to-keep. You are asked this once per round.`;

/**
 * The lesson check of a round with this feedback. It applies only when a trusted human commented or reviewed: then a
 * hand-back with no note changed and no `--nothing-to-keep` is refused, once.
 */
export function createLessons(feedback: readonly Feedback[] = []): Lessons {
  const from = teachers(feedback);
  let noted = false;
  let nothing = false;
  let refused = false;

  return {
    noted: () => {
      noted = true;
    },
    check(nothingToKeep) {
      nothing ||= nothingToKeep;
      if (from.length === 0 || noted || nothing || refused) {
        return undefined;
      }

      refused = true;
      return lessonRefusal(from);
    },
    outcome() {
      if (from.length === 0) {
        return undefined;
      }

      const kept = noted ? "noted" : nothing ? "nothing" : "unanswered";
      return { from, refused, kept };
    },
  };
}
