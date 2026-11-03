import { sampleRunRequest } from "@outstaff/core/contracts";
import type { RuntimeEvent } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { createScriptedRuntime, RUN_USAGE, SCRIPTED_MODEL } from "#/runtime.js";

async function finished(events: AsyncIterable<RuntimeEvent>) {
  let last: RuntimeEvent | undefined;
  let started: string | undefined;
  for await (const e of events) {
    started = e.type === "started" ? e.sessionId : started;
    last = e.type === "finished" ? e : last;
  }

  return { started, last: last as Extract<RuntimeEvent, { type: "finished" }> };
}

describe("the scripted runtime's usage", () => {
  it("reports each session's running total, one run's usage more per run", async () => {
    const runtime = createScriptedRuntime();
    const first = await finished(runtime.run(sampleRunRequest()));
    expect(first.last.usage).toEqual({ [SCRIPTED_MODEL]: RUN_USAGE });
    const again = await finished(runtime.run(sampleRunRequest({ sessionId: first.started! })));

    expect(again.last.usage?.[SCRIPTED_MODEL]).toEqual({
      inputTokens: 2 * RUN_USAGE.inputTokens,
      outputTokens: 2 * RUN_USAGE.outputTokens,
      cacheReadTokens: 2 * RUN_USAGE.cacheReadTokens,
      cacheCreationTokens: 2 * RUN_USAGE.cacheCreationTokens,
      costUsd: 0.04,
    });

    const other = await finished(runtime.run(sampleRunRequest()));
    expect(other.last.usage).toEqual({ [SCRIPTED_MODEL]: RUN_USAGE });
  });
});
