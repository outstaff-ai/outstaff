import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent } from "@outstaff/core";
import { mapMessage } from "./messages.js";
import type { MapState } from "./types.js";

type Finished = Extract<RuntimeEvent, { type: "finished" }>;

/** What Claude Code says when `resume` names a session it cannot find. */
const SESSION_LOST =
  /no conversation found|session\b.{0,40}\b(not found|expired|does not exist|unknown)/i;

/** Marks a failed finish as a lost session when the run tried to resume one. */
export function markLost(e: Finished, resumed: boolean): RuntimeEvent {
  return resumed && !e.ok && !e.interrupted && e.error && SESSION_LOST.test(e.error)
    ? { ...e, sessionLost: true }
    : e;
}

/**
 * Yields one message's events. Hook decisions for the calls in this message arrive before its results; they are
 * flushed ahead of the result and after the rest. Returns whether the message finished the session.
 */
export function* withDecisions(
  events: RuntimeEvent[],
  pending: RuntimeEvent[],
  resumed: boolean,
): Generator<RuntimeEvent, boolean> {
  let finished = false;
  for (const e of events) {
    if (e.type !== "finished") {
      yield e;
      continue;
    }

    yield* pending.splice(0);
    finished = true;
    yield markLost(e, resumed);
  }

  yield* pending.splice(0);
  return finished;
}

/** The finish of a session that threw: interrupted when the run was aborted, the error otherwise. */
export function crashed(error: unknown, text: string, signal: AbortSignal | undefined): Finished {
  const interrupted = signal?.aborted === true;
  return {
    type: "finished",
    ok: false,
    text,
    ...(interrupted
      ? { interrupted: true }
      : { error: error instanceof Error ? error.message : String(error) }),
  };
}

/**
 * Yields the events of a session's messages, ending with a finish when it throws before one. Returns whether a
 * finish was yielded.
 */
export async function* sessionEvents(
  open: () => AsyncIterable<SDKMessage>,
  run: {
    pending: RuntimeEvent[];
    state: MapState;
    signal?: AbortSignal | undefined;
    resumed: boolean;
  },
): AsyncGenerator<RuntimeEvent, boolean> {
  const { pending, state, signal, resumed } = run;
  let finished = false;
  try {
    for await (const m of open()) {
      finished = (yield* withDecisions(mapMessage(m, state, signal), pending, resumed)) || finished;
    }

    return finished;
  } catch (e) {
    yield* pending.splice(0);
    if (!finished) {
      yield markLost(crashed(e, state.lastText, signal), resumed);
    }

    return true;
  }
}
