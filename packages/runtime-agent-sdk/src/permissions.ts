import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { evaluate, type Decision, type Policy, type ToolCall } from "@outstaff/core";
import { HARMLESS_NAMES, OST_SERVER } from "./tools.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The local files an Artifact call publishes: the page, supporting files, an upload and the folder they resolve against. */
function artifactSources(input: Record<string, unknown>): { path?: string; paths?: string[] } {
  const paths: string[] = [];
  const add = (v: unknown) => {
    const p = str(v);
    if (p !== undefined) {
      paths.push(p);
    }
  };

  const root = str(input["root"]);
  add(root);
  // Sources in `files` are relative to `root` (or the working directory without one).
  const addIn = (v: unknown) =>
    add(root !== undefined && str(v) && !String(v).startsWith("/") ? `${root}/${String(v)}` : v);

  if (Array.isArray(input["file_paths"])) {
    input["file_paths"].forEach(add);
  }

  const files = input["files"];
  if (Array.isArray(files)) {
    files.forEach((f) => addIn((f as { path?: unknown } | null)?.path));
  } else if (files && typeof files === "object") {
    for (const f of Object.values(files)) {
      addIn(typeof f === "object" && f !== null ? (f as { from?: unknown }).from : f);
    }
  }

  const path = str(input["file_path"]);
  return { ...(path === undefined ? {} : { path }), ...(paths.length ? { paths } : {}) };
}

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
    case "Artifact":
      return { kind: "artifact", cwd, ...artifactSources(i) };
    case "ArtifactComments":
    case "ToolSearch":
      return { kind: "artifact", cwd };
    default: {
      const prefix = `mcp__${OST_SERVER}__`;
      // A verb's tool name is its name with the dots as underscores (`ticket_create` for `ticket.create`).
      return name.startsWith(prefix)
        ? { kind: "ost", cwd, command: name.slice(prefix.length).replaceAll("_", ".") }
        : undefined;
    }
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
