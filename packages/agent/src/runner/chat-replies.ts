import type { WorkSummary } from "@outstaff/protocol";
import type { ChatMessageResult } from "../verbs/office.types.js";

type Describe = (work: WorkSummary[]) => string[];

/** The question where filed work goes, when the person is busy. */
export const placementQuestion = (hasPm: boolean, describe: Describe, work: WorkSummary[]) => {
  const where = hasPm
    ? "next, after one of these (say its number), last, or ask the PM"
    : "next, after one of these (say its number), or last";

  return [
    `I'm busy right now. My work, in the order it runs:`,
    ...describe(work),
    `Where does this go: ${where}? It waits at the end until you say.`,
  ].join("\n");
};

/** The answer when the office could not tell where the filed work goes. */
const unclearReply = (hasPm: boolean, describe: Describe, work: WorkSummary[]) =>
  [
    "I did not get where this goes. Say next, last or after one of these (by number)" +
      (hasPm ? ", or ask me to check with the PM:" : ":"),
    ...describe(work),
  ].join("\n");

/** What the agent answers a trusted human's message with, given what the office made of it. */
export function replyFor(
  r: ChatMessageResult,
  hasPm: boolean,
  describe: Describe,
): string | undefined {
  switch (r.disposition) {
    case "started":
      // The reaction shows it was seen; the first reply comes with the ticket, when the request is work.
      return undefined;
    case "limited":
      return "I am answering other chats right now. Yours is next in line.";
    case "placed":
      return `Got it, this goes ${r.placement ?? "where you said"}.`;
    case "asked_pm":
      return "I asked the PM to prioritize it. It waits at the end of my queue until you tell me where it goes.";
    case "unclear":
      return unclearReply(hasPm, describe, r.work);
    case "joined":
      return undefined;
  }
}
