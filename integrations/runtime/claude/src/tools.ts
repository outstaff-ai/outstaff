import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { PortError, type RuntimeTool, type ToolKind } from "@outstaff/core";
import type { ZodRawShape } from "zod";

export const OST_SERVER = "ost";

/** Neutral tool kind -> SDK built-in tool names. `ost` is served in process and has no built-in. */
export const BUILTIN_NAMES: Record<ToolKind, string[]> = {
  read: ["Read"],
  search: ["Grep", "Glob"],
  edit: ["Edit"],
  write: ["Write"],
  shell: ["Bash"],
  web_fetch: ["WebFetch"],
  subagent: ["Task", "Agent"],
  // ToolSearch is how Claude Code loads ArtifactComments, which it defers.
  artifact: ["Artifact", "ArtifactComments", "ToolSearch"],
  ost: [],
};

/**
 * Always available: they cannot touch the machine. Skill is how rendered skills run.
 * The permission hook still sees them and lets them through.
 */
export const HARMLESS_NAMES = ["Skill", "TodoWrite"];

const EVERY_BUILTIN = [
  ...Object.values(BUILTIN_NAMES).flat(),
  "NotebookEdit",
  "MultiEdit",
  "ArtifactData",
  "ClaudeDesign",
  "WebSearch",
  "KillShell",
  "BashOutput",
];

export function builtinToolNames(kinds: readonly ToolKind[]): string[] {
  return [...new Set([...kinds.flatMap((k) => BUILTIN_NAMES[k]), ...HARMLESS_NAMES])];
}

/** Everything we know of that is not allowed. `tools` already removes it; this is the second lock. */
export function disallowedToolNames(kinds: readonly ToolKind[]): string[] {
  const keep = new Set(builtinToolNames(kinds));
  return EVERY_BUILTIN.filter((n) => !keep.has(n));
}

function shapeOf(t: RuntimeTool): ZodRawShape {
  const shape = (t.input as { shape?: ZodRawShape }).shape;
  if (!shape || typeof shape !== "object") {
    throw new PortError("invalid", `Tool ${t.name}: input must be a zod object schema.`);
  }

  return shape;
}

export function toSdkTools(
  tools: readonly RuntimeTool[],
  workItemId?: string,
): SdkMcpToolDefinition<ZodRawShape>[] {
  return tools.map((t) =>
    tool(t.name, t.description, shapeOf(t), async (args) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: await t.handler(args, workItemId === undefined ? {} : { workItemId }),
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
        };
      }
    }),
  );
}

export function ostServer(
  tools: readonly RuntimeTool[],
  workItemId?: string,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: OST_SERVER, tools: toSdkTools(tools, workItemId) });
}
