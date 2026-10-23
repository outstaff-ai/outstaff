import { z } from "zod";

export const agentSdkOptions = z.object({
  /** Model alias or id used when a run does not name one. */
  model: z.string().min(1).default("sonnet"),

  /** Path to a pinned Claude Code binary. Without it the SDK runs the binary it bundles. */
  claudeCodePath: z.string().min(1).optional(),

  /** Upper bound on agent turns per run; a run request can lower or replace it. */
  maxTurns: z.number().int().positive().optional(),
});

export type AgentSdkOptions = z.infer<typeof agentSdkOptions>;
