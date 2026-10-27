import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@outstaff/core";
import { sampleRunRequest } from "@outstaff/core/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { agentSdkOptions } from "#/options.js";
import { createAgentSdkRuntime } from "#/runtime.js";

// Uses whatever credentials the environment has. Run with OUTSTAFF_TEST_LIVE_SDK=1.
const live = process.env["OUTSTAFF_TEST_LIVE_SDK"] === "1";
const dir = live ? mkdtempSync(join(tmpdir(), "ost-live-")) : "";
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!live)("live Claude Agent SDK run (OUTSTAFF_TEST_LIVE_SDK=1)", () => {
  it("replies and reports usage", { timeout: 120_000 }, async () => {
    const rt = createAgentSdkRuntime({ options: agentSdkOptions.parse({ model: "haiku" }) });
    const events: RuntimeEvent[] = [];
    const req = sampleRunRequest({
      prompt: "Reply with the word ok and nothing else.",
      workdir: dir,
      builtinTools: [],
      maxTurns: 3,
    });

    for await (const e of rt.run(req)) {
      events.push(e);
    }

    const finished = events.find((e) => e.type === "finished");
    expect(finished).toMatchObject({ type: "finished", ok: true });
    expect(events[0]?.type).toBe("started");
    // Only subscription logins report usage windows; an API key or a cloud provider does not.
    const subscription =
      !process.env["ANTHROPIC_API_KEY"] &&
      !process.env["CLAUDE_CODE_USE_BEDROCK"] &&
      !process.env["CLAUDE_CODE_USE_VERTEX"] &&
      !process.env["CLAUDE_CODE_USE_FOUNDRY"];

    expect(!subscription || events.some((e) => e.type === "usage")).toBe(true);
  });
});
