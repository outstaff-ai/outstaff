import type { TeamConfig } from "@outstaff/core";
import type { ContextLimits } from "./context.types.js";

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  comments: 5,
  messages: 10,
  threads: 5,
  reviews: 10,
  items: 8,
  bodyChars: 1500,
};

/** The team's `pipeline.context` limits over the defaults. */
export function contextLimits(team: Pick<TeamConfig, "pipeline">): ContextLimits {
  const c = team.pipeline?.context ?? {};
  const d = DEFAULT_CONTEXT_LIMITS;
  const or = (set: number | undefined, fallback: number) => set ?? fallback;
  return {
    comments: or(c.comments, d.comments),
    messages: or(c.messages, d.messages),
    threads: or(c.threads, d.threads),
    reviews: or(c.reviews, d.reviews),
    items: or(c.items, d.items),
    bodyChars: or(c.body_chars, d.bodyChars),
  };
}
