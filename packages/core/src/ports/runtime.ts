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
  model?: string;
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

export type RuntimeEvent =
  | {
      type: "started";
      sessionId: string;

      /** The concrete model the session runs, when the runtime tells (also when it picked its default). */
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
