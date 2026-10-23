import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { claudeAgentSdk } from "./adapter.js";

const ctx = (scope: "person" | "office"): DeriveContext => ({
  team: {} as TeamConfig,
  scope,
  options: {},
  fetch: (() => {
    throw new Error("no network expected");
  }) as unknown as typeof fetch,
  now: () => new Date(),
  warn: () => {},
});

const run = (env: Record<string, string>, scope: "person" | "office" = "person") =>
  claudeAgentSdk.doctor!(envSecretSource(env, "/nonexistent"), ctx(scope));

describe("claude-agent-sdk doctor", () => {
  it.each([
    { ANTHROPIC_API_KEY: "fake-api-key" },
    { CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth" },
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { CLAUDE_CODE_USE_VERTEX: "1" },
  ])("accepts %o", async (env) => {
    const [check] = await run(env);
    expect(check!.status).toBe("ok");
    expect(JSON.stringify(check)).not.toContain("fake");
  });

  it("fails when no credential is supplied, listing the options", async () => {
    const [check] = await run({});
    expect(check).toMatchObject({ status: "fail" });
    expect(check!.detail).toContain("ANTHROPIC_API_KEY");
    expect(check!.detail).toContain("CLAUDE_CODE_USE_BEDROCK");
  });

  it("needs nothing for the office", async () => {
    expect(await run({}, "office")).toEqual([]);
  });
});
