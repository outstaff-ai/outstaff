import { evaluate } from "#/permissions/index.js";
import type { RunRequest, RuntimeEvent, UsageEvent } from "#/ports/index.js";
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
      yield { type: "started", sessionId: req.sessionId ?? `fake-session-${++sessions}` };
      yield* play(steps, req);
    },
  };

  return runtime;
}

/** Plays the steps of one run; an aborted signal interrupts it before the next step. */
async function* play(steps: FakeRunStep[], req: RunRequest): AsyncGenerator<RuntimeEvent> {
  let last = "";
  for (const step of steps) {
    if (req.signal?.aborted) {
      yield interrupted(last);
      return;
    }

    const event = stepEvent(step, req, last);
    yield event;
    if (event.type === "finished") {
      return;
    }

    last = step.type === "text" ? step.text : last;
  }

  yield req.signal?.aborted ? interrupted(last) : { type: "finished", ok: true, text: last };
}

const interrupted = (text: string): RuntimeEvent => ({
  type: "finished",
  ok: false,
  text,
  interrupted: true,
});

/** The event a step emits; `last` is the text of the latest text step, the default text of a finish. */
function stepEvent(step: FakeRunStep, req: RunRequest, last: string): RuntimeEvent {
  switch (step.type) {
    case "text":
      return { type: "text", text: step.text };
    case "tool_call":
      return {
        type: "tool_call",
        tool: step.tool,
        input: step.call,
        decision: evaluate(req.policy, step.call),
      };
    case "usage":
      return step;
    default:
      return finished(step, last);
  }
}

function finished(step: Extract<FakeRunStep, { type: "finish" }>, last: string): RuntimeEvent {
  return {
    type: "finished",
    ok: step.ok ?? true,
    text: step.text ?? last,
    ...(step.error !== undefined ? { error: step.error } : {}),
    ...(step.costUsd !== undefined ? { costUsd: step.costUsd } : {}),
    ...(step.sessionLost ? { sessionLost: true } : {}),
  };
}
