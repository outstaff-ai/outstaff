import { evaluate } from "../permissions/index.js";
import type { RunRequest, RuntimeEvent, UsageEvent } from "../ports/index.js";
import type { FakeRunStep, FakeRuntime } from "./types.js";

export function createFakeRuntime(): FakeRuntime {
  const queue: FakeRunStep[][] = [];
  const requests: RunRequest[] = [];
  let sessions = 0;
  const usage: UsageEvent = {
    type: "usage",
    windows: [
      { name: "five_hour", utilization: 0.1 },
      { name: "seven_day", utilization: 0.02 },
    ],
  };

  const runtime: FakeRuntime = {
    requests,
    usage,
    enqueue: (steps) => void queue.push(steps),
    seed: { script: async (text) => void queue.push([{ type: "text", text }]) },
    async probeUsage() {
      return structuredClone(usage);
    },
    async *run(req) {
      requests.push(req);
      const steps = queue.shift() ?? [{ type: "text", text: "ok" }];
      yield {
        type: "started",
        sessionId: req.sessionId ?? `fake-session-${++sessions}`,
      } satisfies RuntimeEvent;

      let last = "";
      for (const step of steps) {
        if (req.signal?.aborted) {
          yield { type: "finished", ok: false, text: last, interrupted: true };
          return;
        }

        if (step.type === "text") {
          last = step.text;
          yield { type: "text", text: step.text };
        } else if (step.type === "tool_call") {
          yield {
            type: "tool_call",
            tool: step.tool,
            input: step.call,
            decision: evaluate(req.policy, step.call),
          };
        } else if (step.type === "usage") {
          yield step;
        } else {
          const text = step.text ?? last;
          yield {
            type: "finished",
            ok: step.ok ?? true,
            text,
            ...(step.error !== undefined ? { error: step.error } : {}),
            ...(step.costUsd !== undefined ? { costUsd: step.costUsd } : {}),
            ...(step.sessionLost ? { sessionLost: true } : {}),
          };

          return;
        }
      }

      if (req.signal?.aborted) {
        yield { type: "finished", ok: false, text: last, interrupted: true };
      } else {
        yield { type: "finished", ok: true, text: last };
      }
    },
  };

  return runtime;
}
