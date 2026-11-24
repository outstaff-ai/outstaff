import type { LessonCheck } from "@outstaff/protocol";

const KEPT: Record<LessonCheck["kept"], string> = {
  noted: "a note changed in the round",
  nothing: "the agent said there was nothing to keep",
  unanswered: "no note changed, and the agent did not say there was nothing to keep",
};

/** The journal's line about the lesson check of a round whose feedback a trusted human gave. */
export function lessonLine({ from, refused, kept }: LessonCheck): string {
  const who = `${from.join(", ")}, ${from.length === 1 ? "a trusted human" : "trusted humans"}`;
  const asked = refused ? "; the hand-back was refused once to ask for a lesson" : "";
  return `Lesson check: feedback from ${who}${asked}; ${KEPT[kept]}.`;
}
