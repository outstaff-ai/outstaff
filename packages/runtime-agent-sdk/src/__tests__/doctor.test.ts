import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeAgentSdk } from "../adapter.js";
import { probeSubprocessSandbox, type SandboxProbe } from "../sandbox.js";

vi.mock("../sandbox.js", () => ({ probeSubprocessSandbox: vi.fn<() => SandboxProbe>() }));
const probe = vi.mocked(probeSubprocessSandbox);
const realPlatform = process.platform;
const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p });
beforeEach(() => probe.mockReturnValue({ ok: true, detail: "bubblewrap runs." }));
afterEach(() => {
  onPlatform(realPlatform);
  probe.mockReset();
});

const ctx = (scope: "person" | "office", options: unknown = {}): DeriveContext => ({
  team: {} as TeamConfig,
  scope,
  options,
  fetch: (() => {
    throw new Error("no network expected");
  }) as unknown as typeof fetch,
  now: () => new Date(),
  warn: () => {},
});

const run = (
  env: Record<string, string>,
  scope: "person" | "office" = "person",
  options: unknown = {},
  extra: Partial<DeriveContext> = {},
) =>
  claudeAgentSdk.doctor!(envSecretSource(env, "/nonexistent"), {
    ...ctx(scope, options),
    ...extra,
  });

const KEY = { ANTHROPIC_API_KEY: "fake-api-key" };
const BWRAP = { sandbox: "bubblewrap" };
const create = (options: unknown) =>
  claudeAgentSdk.create({
    options: claudeAgentSdk.options.parse(options),
    secrets: envSecretSource({}, "/nonexistent"),
  } as never);

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

  it("adds the subprocess sandbox check with sandbox: bubblewrap on Linux, where the agent runs", async () => {
    onPlatform("linux");
    probe.mockReturnValue({
      ok: false,
      detail: "/proc is masked.",
      fix: "Set procMount: Unmasked.",
    });

    const checks = await run(KEY, "person", BWRAP);
    expect(checks[1]).toEqual({
      name: "Subprocess sandbox",
      status: "fail",
      detail: "/proc is masked.",
      fix: "Set procMount: Unmasked.",
    });

    probe.mockReturnValue({ ok: true, detail: "bubblewrap runs." });
    expect((await run(KEY, "person", BWRAP))[1]).toMatchObject({ status: "ok" });
  });

  it("skips the sandbox check with sandbox: off, and off Linux", async () => {
    onPlatform("linux");
    expect(await run(KEY)).toHaveLength(1);
    onPlatform("darwin");
    expect(await run(KEY, "person", BWRAP)).toHaveLength(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses to create the runtime with sandbox: bubblewrap when the sandbox cannot run", () => {
    probe.mockReturnValue({
      ok: false,
      detail: "bwrap is not installed.",
      fix: "Use the agent image.",
    });

    expect(() => create({ sandbox: "bubblewrap" })).toThrow(
      /^sandbox: bubblewrap cannot run in this container\. bwrap is not installed\. Fix: Use the agent image\.$/,
    );
  });

  it("does not probe at all with sandbox: off", () => {
    probe.mockReturnValue({ ok: false, detail: "bwrap is not installed." });
    expect(() => create({})).not.toThrow();
    expect(probe).not.toHaveBeenCalled();
  });

  it("needs nothing for the office", async () => {
    expect(await run({}, "office")).toEqual([]);
  });
});

describe("claude-agent-sdk doctor: Design canvas", () => {
  const canvas = { roleCapabilities: ["design.canvas" as const] };
  const checkOf = async (env: Record<string, string>, extra: Partial<DeriveContext> = canvas) =>
    (await run(env, "person", {}, extra)).find((c) => c.name === "Design canvas");

  it("passes with a Claude account token", async () => {
    expect(await checkOf({ CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth" })).toMatchObject({
      status: "ok",
    });
  });

  it.each([{ ANTHROPIC_API_KEY: "fake-api-key" }, { CLAUDE_CODE_USE_BEDROCK: "1" }, {}])(
    "warns without one: %o",
    async (env) => {
      const check = await checkOf(env);
      expect(check).toMatchObject({ status: "warn" });
      expect(check!.fix).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(JSON.stringify(check)).not.toContain("fake");
    },
  );

  it("says nothing for a role without the capability, or with the switch off", async () => {
    expect(await checkOf({ ANTHROPIC_API_KEY: "fake-api-key" }, {})).toBeUndefined();
    const off = { ...canvas, team: { policies: { design: { canvas: false } } } as TeamConfig };
    expect(await checkOf({ ANTHROPIC_API_KEY: "fake-api-key" }, off)).toBeUndefined();
  });
});
