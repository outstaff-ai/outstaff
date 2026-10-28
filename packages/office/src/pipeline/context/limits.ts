import type { TeamConfig } from "@outstaff/core";
import type { ContextLimits } from "./context.types.js";

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  comments: 5,
  messages: 10,
  threads: 5,
  items: 8,
  bodyChars: 1500,
};

/** The team's `pipeline.context` limits over the defaults. */
export function contextLimits(team: Pick<TeamConfig, "pipeline">): ContextLimits {
  const c = team.pipeline?.context ?? {};
  const d = DEFAULT_CONTEXT_LIMITS;
  return {
    comments: c.comments ?? d.comments,
    messages: c.messages ?? d.messages,
    threads: c.threads ?? d.threads,
    items: c.items ?? d.items,
    bodyChars: c.body_chars ?? d.bodyChars,
  };
}
