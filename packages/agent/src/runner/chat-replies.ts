import type { WorkSummary } from "@outstaff/protocol";

type Describe = (work: WorkSummary[]) => string[];

/** The question where filed work goes, when the person is busy. The answer reaches a chat session, which moves it. */
export const placementQuestion = (describe: Describe, work: WorkSummary[]) =>
  [
    `I'm busy right now. My work, in the order it runs:`,
    ...describe(work),
    "Where does this go: next, after one of these (say its number), or last? It waits at the end until you say.",
  ].join("\n");
