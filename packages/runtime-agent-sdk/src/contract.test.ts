import { runtimeContract } from "@outstaff/core/contracts";
import { describe, expect, it } from "vitest";
import { claudeAgentSdk } from "./adapter.js";
import { agentSdkOptions } from "./options.js";
import { createAgentSdkRuntime } from "./runtime.js";
import { assistant, fakeQuery, init, rateLimit, result } from "./testing.js";

runtimeContract("claude-agent-sdk (mocked query)", async () => {
  const scripts: string[] = [];
  let sessions = 0;
  const { query } = fakeQuery(({ options }) => {
    const text = scripts.shift() ?? "ok";
    return [
      init(options.resume ?? `session-${++sessions}`),
      assistant(text),
      rateLimit(),
      result({ result: text }),
    ];
  });

  return {
    subject: createAgentSdkRuntime({ options: agentSdkOptions.parse({}), query }),
    seed: { script: async (text) => void scripts.push(text) },
    capabilities: claudeAgentSdk.capabilities,
  };
});

describe("adapter definition", () => {
  it("is a runtime adapter with optional credentials and no required secrets", () => {
    expect(claudeAgentSdk).toMatchObject({ port: "runtime", name: "claude-agent-sdk" });
    for (const scope of ["person", "office"] as const) {
      const specs = claudeAgentSdk.secrets(scope);
      expect(specs.map((s) => s.key)).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
      for (const s of specs) {
        expect(s.optional).toBe(true);
      }
    }
  });

  it("validates options and defaults the model", () => {
    expect(claudeAgentSdk.options.parse({})).toEqual({ model: "sonnet" });
    expect(() => claudeAgentSdk.options.parse({ maxTurns: 0 })).toThrow(/maxTurns/);
  });
});
