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
  const windows: UsageEvent["windows"] = [];
  if (isRec(info["unifiedWindows"])) {
    for (const [name, w] of Object.entries(info["unifiedWindows"])) {
      const parsed = isRec(w) ? window(name, w["utilization"], w["resetsAt"]) : undefined;
      if (parsed) {
        windows.push(parsed);
      }
    }
  }

  if (windows.length === 0 && typeof info["rateLimitType"] === "string") {
    const parsed = window(info["rateLimitType"], info["utilization"], info["resetsAt"]);
    if (parsed) {
      windows.push(parsed);
    }
  }

  return windows.length > 0 ? { type: "usage", windows } : undefined;
}

/** Maps one SDK message to zero or more events. `tool_call` events come from the permission hook instead. */
export function mapMessage(m: SDKMessage, state: MapState, signal?: AbortSignal): RuntimeEvent[] {
  const msg = m as unknown as Rec;
  switch (msg["type"]) {
    case "system":
      return msg["subtype"] === "init" && typeof msg["session_id"] === "string"
        ? [{ type: "started", sessionId: msg["session_id"] }]
        : [];
    case "assistant": {
      if (msg["parent_tool_use_id"]) {
        return [];
      }

      const content =
        isRec(msg["message"]) && Array.isArray(msg["message"]["content"])
          ? msg["message"]["content"]
          : [];

      const text = content
        .filter((b): b is Rec => isRec(b) && b["type"] === "text" && typeof b["text"] === "string")
        .map((b) => b["text"] as string)
        .join("");

      if (text === "") {
        return [];
      }

      state.lastText = text;
      return [{ type: "text", text }];
    }

    case "rate_limit_event": {
      const usage = parseUsage(msg);
      return usage ? [usage] : [];
    }

    case "result": {
      const ok = msg["subtype"] === "success" && msg["is_error"] !== true;
      const interrupted =
        signal?.aborted === true || msg["terminal_reason"] === "aborted_streaming";

      const errors = Array.isArray(msg["errors"])
        ? msg["errors"].filter((e): e is string => typeof e === "string")
        : [];

      const text = typeof msg["result"] === "string" ? msg["result"] : state.lastText;
      const error = ok ? undefined : errors.join("; ") || String(msg["subtype"] ?? "error");
      return [
        {
          type: "finished",
          ok: ok && !interrupted,
          text,
          ...(typeof msg["total_cost_usd"] === "number" ? { costUsd: msg["total_cost_usd"] } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(interrupted ? { interrupted: true } : {}),
        },
      ];
    }

    default:
      return [];
  }
}
