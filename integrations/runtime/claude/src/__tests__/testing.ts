import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildPolicy, type Policy } from "@outstaff/core";
import type { Call, QueryFn } from "#/types.js";

const layout = {
  home: "/home/agent",
  workDir: "/work/main",
  reposDir: "/work/repos",
  worktreesDir: "/work/worktrees",
  scratchDir: "/work/scratch",
  memoryDir: "/work/memory",
  secretsDir: "/work/secrets",
};

export function codePolicy(): Policy {
  return buildPolicy({
    profile: "code",
    person: { repos: { acme: "write" } },
    team: {
      repos: [{ name: "acme", url: "https://github.com/acme/app", default_branch: "main" }],
    } as never,
    layout,
  });
}

const m = (x: unknown) => x as SDKMessage;
export const init = (sessionId: string) =>
  m({ type: "system", subtype: "init", session_id: sessionId });

export const assistant = (text: string) =>
  m({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text }] },
  });

export const result = (extra: Record<string, unknown> = {}) =>
  m({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    total_cost_usd: 0.01,
    ...extra,
  });

export const rateLimit = () =>
  m({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.07, resetsAt: 1792761000 },
        seven_day: { utilization: 0.24, resetsAt: 1793188800 },
      },
    },
  });

/** A fake `query` that records its calls and plays the messages `script` returns. */
export function fakeQuery(script: (call: Call) => AsyncIterable<SDKMessage> | SDKMessage[]): {
  query: QueryFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const out = script(params);
    return Array.isArray(out)
      ? (async function* () {
          yield* out;
        })()
      : out;
  };

  return { query, calls };
}
