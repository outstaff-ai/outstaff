import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { evaluate, type Decision, type Policy, type ToolCall, type ToolKind } from "@outstaff/core";
import { HARMLESS_NAMES, OST_SERVER } from "./tools.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

type Input = Record<string, unknown>;

/** Sources in `files` are relative to `root` (or the working directory without one). */
function underRoot(root: string | undefined, v: unknown): unknown {
  return root !== undefined && str(v) && !String(v).startsWith("/") ? `${root}/${String(v)}` : v;
}

/** The sources named in `files`: a list of `{ path }`, or a map of published path to a source or `{ from }`. */
function fileSources(files: unknown): unknown[] {
  if (Array.isArray(files)) {
    return files.map((f) => (f as { path?: unknown } | null)?.path);
  }

  if (files && typeof files === "object") {
    return Object.values(files).map((f) =>
      typeof f === "object" && f !== null ? (f as { from?: unknown }).from : f,
    );
  }

  return [];
}

/** The local files an Artifact call publishes: the page, supporting files, an upload and the folder they resolve against. */
function artifactSources(input: Input): { path?: string; paths?: string[] } {
  const root = str(input["root"]);
  const uploads: unknown[] = Array.isArray(input["file_paths"]) ? input["file_paths"] : [];
  const files = fileSources(input["files"]).map((v) => underRoot(root, v));
  const paths = [root, ...uploads, ...files].map(str).filter((p): p is string => p !== undefined);

  const path = str(input["file_path"]);
  return { ...(path === undefined ? {} : { path }), ...(paths.length ? { paths } : {}) };
}

type Build = (input: Input, cwd: string) => ToolCall;

/** A call of `kind` on the path in `key`, when the input names one. */
const onPath =
  (kind: ToolKind, key: string): Build =>
  (input, cwd) => {
    const path = str(input[key]);
    return { kind, cwd, ...(path === undefined ? {} : { path }) };
  };

const plain =
  (kind: ToolKind): Build =>
  (_input, cwd) => ({ kind, cwd });

function shell(input: Input, cwd: string): ToolCall {
  const command = str(input["command"]);
  return { kind: "shell", cwd, ...(command === undefined ? {} : { command }) };
}

const BY_TOOL = new Map<string, Build>([
  ["Bash", shell],
  ["Read", onPath("read", "file_path")],
  ["Edit", onPath("edit", "file_path")],
  ["MultiEdit", onPath("edit", "file_path")],
  ["NotebookEdit", onPath("edit", "notebook_path")],
  ["Write", onPath("write", "file_path")],
  ["Grep", onPath("search", "path")],
  ["Glob", onPath("search", "path")],
  ["WebFetch", plain("web_fetch")],
  ["Task", plain("subagent")],
  ["Agent", plain("subagent")],
  ["Artifact", (input, cwd) => ({ kind: "artifact", cwd, ...artifactSources(input) })],
  ["ArtifactComments", plain("artifact")],
  ["ToolSearch", plain("artifact")],
]);

/** A verb's tool name is its name with the dots as underscores (`ticket_create` for `ticket.create`). */
function ostVerb(name: string, cwd: string): ToolCall | undefined {
  const prefix = `mcp__${OST_SERVER}__`;
  return name.startsWith(prefix)
    ? { kind: "ost", cwd, command: name.slice(prefix.length).replaceAll("_", ".") }
    : undefined;
}

/** Maps an SDK tool call to the neutral call, or undefined for a tool the policy has no kind for. */
export function toToolCall(name: string, input: unknown, cwd: string): ToolCall | undefined {
  const i = (input && typeof input === "object" ? input : {}) as Input;
  const build = BY_TOOL.get(name);
  return build ? build(i, cwd) : ostVerb(name, cwd);
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

/** A PreToolUse hook that judges every call. */
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

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Denied by the permission policy: ${decision.reason}`,
      },
    };
  };
}
