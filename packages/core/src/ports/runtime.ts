import type { ZodType } from "zod";
import type { Decision, Policy, ToolKind } from "#/permissions/index.js";

/** An `ost` verb exposed to the agent. */
export interface RuntimeTool {
  name: string;
  description: string;
  input: ZodType;
  handler(input: unknown, ctx: { workItemId?: string }): Promise<string>;
}

export interface RunRequest {
  sessionId?: string;

  /** Passed to `ost` tool handlers as context. */
  workItemId?: string;
  prompt: string;
  systemPrompt: string;
  workdir: string;
  addDirs: string[];

  /** The adapter enforces it (hooks or rules), using `evaluate()` as the reference. */
  policy: Policy;
  tools: RuntimeTool[];
  builtinTools: ToolKind[];

  /** The model the person is configured with. There is no default: an adapter refuses a run without one. */
  model: string;
  maxTurns?: number;
  signal?: AbortSignal;
}

export type UsageEvent = {
  type: "usage";
  windows: {
    name: "five_hour" | "seven_day" | (string & {});
    utilization: number;
    resetsAt?: string;
  }[];
};

/** Tokens and cost of one model in a session. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;

  /** What the tokens cost at API list prices, when the runtime knows: an estimate, not a bill. */
  costUsd?: number | undefined;
}

/**
 * A session's usage so far, per model id. A running total, as the Claude Agent SDK reports it: a resumed session's
 * figures include its earlier runs, so a run's own usage is the difference to the session's previous report.
 */
export type SessionUsage = Record<string, ModelUsage>;

export type RuntimeEvent =
  | {
      type: "started";
      sessionId: string;

      /** The concrete model id the session runs, when the runtime tells (an alias in `RunRequest.model` resolved). */
      model?: string;
    }
  | { type: "text"; text: string }
  | { type: "tool_call"; tool: string; input: unknown; decision: Decision }
  | UsageEvent
  | {
      type: "finished";
      ok: boolean;
      text: string;
      costUsd?: number;

      /** The session's running usage per model, when the runtime reports it. */
      usage?: SessionUsage;
      error?: string;
      interrupted?: boolean;

      /** The run asked to resume a session the runtime no longer knows (unknown or expired). */
      sessionLost?: boolean;
    };

export interface Runtime {
  run(req: RunRequest): AsyncIterable<RuntimeEvent>;

  /** Capability `runtime.usage`. */
  probeUsage?(): Promise<UsageEvent>;
}
