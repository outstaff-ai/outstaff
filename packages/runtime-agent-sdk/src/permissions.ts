import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { evaluate, type Decision, type Policy, type ToolCall } from "@outstaff/core";
import { HARMLESS_NAMES, OST_SERVER } from "./tools.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Maps an SDK tool call to the neutral call, or undefined for a tool the policy has no kind for. */
export function toToolCall(name: string, input: unknown, cwd: string): ToolCall | undefined {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const path = (key: string) => {
    const p = str(i[key]);
    return p === undefined ? {} : { path: p };
  };

  switch (name) {
    case "Bash": {
      const command = str(i["command"]);
      return { kind: "shell", cwd, ...(command === undefined ? {} : { command }) };
    }

    case "Read":
      return { kind: "read", cwd, ...path("file_path") };
    case "Edit":
    case "MultiEdit":
      return { kind: "edit", cwd, ...path("file_path") };
    case "NotebookEdit":
      return { kind: "edit", cwd, ...path("notebook_path") };
    case "Write":
      return { kind: "write", cwd, ...path("file_path") };
    case "Grep":
    case "Glob":
      return { kind: "search", cwd, ...path("path") };
    case "WebFetch":
      return { kind: "web_fetch", cwd };
    case "Task":
    case "Agent":
      return { kind: "subagent", cwd };
    default:
      return name.startsWith(`mcp__${OST_SERVER}__`) ? { kind: "ost", cwd } : undefined;
  }
}

export function decide(policy: Policy, name: string, input: unknown, cwd: string): Decision {
  if (HARMLESS_NAMES.includes(name)) {
    return { effect: "allow", reason: `${name} is always allowed.`, rule: "runtime.harmless" };
  }

  const call = toToolCall(name, input, cwd);
  if (!call) {
    return {
      effect: "deny",
      reason: `Tool ${name} is not known to the permission policy.`,
      rule: "runtime.unknown-tool",
    };
  }

  return evaluate(policy, call);
}

/** A PreToolUse hook that judges every call. Unattended: `ask` blocks like `deny`. */
export function permissionHook(
  policy: Policy,
  defaultCwd: string,
  onDecision: (tool: string, input: unknown, decision: Decision) => void,
): HookCallback {
  return async (hook): Promise<HookJSONOutput> => {
    if (hook.hook_event_name !== "PreToolUse") {
      return {};
    }

    const cwd = str((hook as { cwd?: unknown }).cwd) ?? defaultCwd;
    const decision = decide(policy, hook.tool_name, hook.tool_input, cwd);
    onDecision(hook.tool_name, hook.tool_input, decision);
    if (decision.effect === "allow") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: decision.reason,
        },
      };
    }

    const prefix =
      decision.effect === "ask"
        ? "Not covered by the permission policy (nobody is available to approve it): "
        : "Denied by the permission policy: ";

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: prefix + decision.reason,
      },
    };
  };
}
