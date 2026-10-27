import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent, UsageEvent } from "@outstaff/core";
import type { MapState } from "./types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function iso(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return undefined;
  }

  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function window(
  name: string,
  utilization: unknown,
  resetsAt: unknown,
): UsageEvent["windows"][number] | undefined {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return undefined;
  }

  const at = iso(resetsAt);
  return { name, utilization, ...(at ? { resetsAt: at } : {}) };
}

/** The windows of the current `unifiedWindows` shape. */
function unifiedWindows(info: Rec): UsageEvent["windows"] {
  const unified = info["unifiedWindows"];
  if (!isRec(unified)) {
    return [];
  }

  return Object.entries(unified).flatMap(([name, w]) => {
    const parsed = isRec(w) ? window(name, w["utilization"], w["resetsAt"]) : undefined;
    return parsed ? [parsed] : [];
  });
}

/** The single window of the older shape, named by its `rateLimitType`. */
function singleWindow(info: Rec): UsageEvent["windows"] {
  if (typeof info["rateLimitType"] !== "string") {
    return [];
  }

  const parsed = window(info["rateLimitType"], info["utilization"], info["resetsAt"]);
  return parsed ? [parsed] : [];
}

/** Parses a rate_limit_event defensively; unknown shapes give undefined. */
export function parseUsage(message: unknown): UsageEvent | undefined {
  if (
    !isRec(message) ||
    message["type"] !== "rate_limit_event" ||
    !isRec(message["rate_limit_info"])
  ) {
    return undefined;
  }

  const info = message["rate_limit_info"];
  const unified = unifiedWindows(info);
  const windows = unified.length > 0 ? unified : singleWindow(info);
  return windows.length > 0 ? { type: "usage", windows } : undefined;
}

type Mapper = (msg: Rec, state: MapState, signal?: AbortSignal) => RuntimeEvent[];

function mapSystem(msg: Rec): RuntimeEvent[] {
  return msg["subtype"] === "init" && typeof msg["session_id"] === "string"
    ? [{ type: "started", sessionId: msg["session_id"] }]
    : [];
}

const isTextBlock = (b: unknown): b is Rec =>
  isRec(b) && b["type"] === "text" && typeof b["text"] === "string";

/** The text blocks of an assistant message, joined. */
function textOf(message: unknown): string {
  const content = isRec(message) && Array.isArray(message["content"]) ? message["content"] : [];
  return content
    .filter(isTextBlock)
    .map((b) => b["text"] as string)
    .join("");
}

/** A subagent's messages carry their parent tool call and are not the session's own text. */
function mapAssistant(msg: Rec, state: MapState): RuntimeEvent[] {
  if (msg["parent_tool_use_id"]) {
    return [];
  }

  const text = textOf(msg["message"]);
  if (text === "") {
    return [];
  }

  state.lastText = text;
  return [{ type: "text", text }];
}

function mapRateLimit(msg: Rec): RuntimeEvent[] {
  const usage = parseUsage(msg);
  return usage ? [usage] : [];
}

/** The error of a failed result: its error strings, or its subtype when it has none. */
function resultError(msg: Rec): string {
  const errors = Array.isArray(msg["errors"])
    ? msg["errors"].filter((e): e is string => typeof e === "string")
    : [];

  return errors.join("; ") || String(msg["subtype"] ?? "error");
}

/** Whether the run was aborted, by its signal or by Claude Code. */
const isInterrupted = (msg: Rec, signal: AbortSignal | undefined) =>
  signal?.aborted === true || msg["terminal_reason"] === "aborted_streaming";

function mapResult(msg: Rec, state: MapState, signal?: AbortSignal): RuntimeEvent[] {
  const ok = msg["subtype"] === "success" && msg["is_error"] !== true;
  const interrupted = isInterrupted(msg, signal);
  const text = typeof msg["result"] === "string" ? msg["result"] : state.lastText;
  return [
    {
      type: "finished",
      ok: ok && !interrupted,
      text,
      ...(typeof msg["total_cost_usd"] === "number" ? { costUsd: msg["total_cost_usd"] } : {}),
      ...(ok ? {} : { error: resultError(msg) }),
      ...(interrupted ? { interrupted: true } : {}),
    },
  ];
}

const MAPPERS = new Map<unknown, Mapper>([
  ["system", mapSystem],
  ["assistant", mapAssistant],
  ["rate_limit_event", mapRateLimit],
  ["result", mapResult],
]);

/** Maps one SDK message to zero or more events. `tool_call` events come from the permission hook instead. */
export function mapMessage(m: SDKMessage, state: MapState, signal?: AbortSignal): RuntimeEvent[] {
  const msg = m as unknown as Rec;
  const mapper = MAPPERS.get(msg["type"]);
  return mapper ? mapper(msg, state, signal) : [];
}
