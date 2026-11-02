import { z } from "zod";
import { mentionGuard } from "./mentions.js";
import type { AgentEnv } from "./types.js";

/** Longest line an agent writes for the reply its agent posts when a chat session files or attaches work. */
export const SAY_MAX = 200;

/** The `say` input of the verbs that file or attach a chat request: one short line, the links follow it. */
export const sayInput = z
  .string()
  .trim()
  .min(1)
  .max(SAY_MAX)
  .regex(/^[^\r\n]*$/, "One line: no line breaks.")
  .optional()
  .describe(
    'In a chat session, one short line your agent posts in the thread, followed by the links: answer what the human actually said, in their terms (for example "Reworking it from your new comment."). No links, no greeting. Without it a fixed line is posted.',
  );

/**
 * The agent's line, checked like the other text it posts: a teammate's `@handle` becomes their name and any other
 * mention is refused, before anything is filed.
 */
export function chatLine(env: AgentEnv, say: string | undefined): string | undefined {
  return say === undefined ? undefined : mentionGuard(env.team).apply(say);
}
