import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeAgentSdk } from "../adapter.js";
import { createAgentSdkRuntime } from "../runtime.js";
import { probeSubprocessSandbox } from "../sandbox.js";
import type { SandboxProbe } from "../types.js";

vi.mock("../sandbox.js", () => ({ probeSubprocessSandbox: vi.fn<() => SandboxProbe>() }));
vi.mock("../runtime.js", () => ({
  createAgentSdkRuntime: vi.fn<typeof createAgentSdkRuntime>(() => ({}) as never),
}));

const probe = vi.mocked(probeSubprocessSandbox);
const createRuntime = vi.mocked(createAgentSdkRuntime);
const realPlatform = process.platform;
const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p });
beforeEach(() => probe.mockReturnValue({ ok: true, detail: "bubblewrap runs." }));
afterEach(() => {
  onPlatform(realPlatform);
  probe.mockReset();
  createRuntime.mockClear();
});

const ctx = (options: unknown, extra: Partial<DeriveContext> = {}): DeriveContext => ({
  team: {} as TeamConfig,
  scope: "person",
  options,
  fetch: (() => {
    throw new Error("no network expected");
  }) as unknown as typeof fetch,
  now: () => new Date(),
  warn: () => {},
  ...extra,
});

const doctor = (env: Record<string, string>, options: unknown = {}, extra = {}) =>
  claudeAgentSdk.doctor!(envSecretSource(env, "/nonexistent"), ctx(options, extra));

describe("claude-agent-sdk setup guide", () => {
  it("tells a person how to sign the agent in, without asking outstaff to hold the credential", () => {
    const steps = claudeAgentSdk.setupGuide!({ scope: "person" } as never);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.title).toContain("signs in to Claude");
    expect(steps[0]!.body).toContain("ANTHROPIC_API_KEY");
    expect(steps[0]!.body).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(steps[0]!.body).toContain("never asks for, stores or brokers");
  });

  it("has nothing to say for the office", () => {
    expect(claudeAgentSdk.setupGuide!({ scope: "office" } as never)).toEqual([]);
  });

  it("declares both credentials as optional secrets", () => {
    const specs = claudeAgentSdk.secrets({} as never);
    expect(specs.map((s) => [s.key, s.optional])).toEqual([
      ["ANTHROPIC_API_KEY", true],
      ["CLAUDE_CODE_OAUTH_TOKEN", true],
    ]);
  });
});

describe("claude-agent-sdk doctor: credential check wording", () => {
  it("names every credential that is set, in the plural", async () => {
    const [check] = await doctor({ ANTHROPIC_API_KEY: "fake", CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(check).toMatchObject({
      key: "ANTHROPIC_API_KEY",
      status: "ok",
      detail: "ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK are set.",
    });
  });

  it("names the single credential in the singular", async () => {
    const [check] = await doctor({ CLAUDE_CODE_USE_VERTEX: "1" });
    expect(check).toMatchObject({
      key: "CLAUDE_CODE_USE_VERTEX",
      detail: "CLAUDE_CODE_USE_VERTEX is set.",
    });
  });
});

describe("claude-agent-sdk doctor: Design canvas wording", () => {
  const canvas = { roleCapabilities: ["design.canvas" as const] };
  const warning = async (env: Record<string, string>) =>
    (await doctor(env, {}, canvas)).find((c) => c.name === "Design canvas")!;

  it("lists the credentials that are set but are not a Claude account login", async () => {
    expect((await warning({ ANTHROPIC_API_KEY: "fake" })).detail).toContain(
      "only ANTHROPIC_API_KEY is set",
    );

    expect(
      (await warning({ ANTHROPIC_API_KEY: "fake", CLAUDE_CODE_USE_BEDROCK: "1" })).detail,
    ).toContain("only ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK are set");

    expect((await warning({})).detail).toContain("no Claude credential is set");
  });
});

describe("claude-agent-sdk doctor: sandbox check input", () => {
  beforeEach(() => onPlatform("linux"));

  it("skips the probe when the options do not parse", async () => {
    const checks = await doctor({ ANTHROPIC_API_KEY: "fake" }, { sandbox: "chroot" });
    expect(checks).toHaveLength(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it("treats missing options as defaults", async () => {
    expect(await doctor({ ANTHROPIC_API_KEY: "fake" }, null)).toHaveLength(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports a passing probe without a fix", async () => {
    const checks = await doctor({ ANTHROPIC_API_KEY: "fake" }, { sandbox: "bubblewrap" });
    expect(checks[1]).toEqual({
      name: "Subprocess sandbox",
      status: "ok",
      detail: "bubblewrap runs.",
    });
  });
});

describe("claude-agent-sdk create", () => {
  const secrets = envSecretSource({}, "/nonexistent");
  const make = (extra: Record<string, unknown>) =>
    claudeAgentSdk.create({
      options: claudeAgentSdk.options.parse({}),
      secrets,
      ...extra,
    } as never);

  it("scrubs the declared secret keys of the whole office from the agent's environment", () => {
    make({ secretKeys: ["GH_APP_PRIVATE_KEY"] });
    expect(createRuntime.mock.calls[0]![0].scrubKeys).toEqual(["GH_APP_PRIVATE_KEY"]);
  });

  it("builds the runtime once the bubblewrap probe passes", () => {
    claudeAgentSdk.create({
      options: claudeAgentSdk.options.parse({ sandbox: "bubblewrap" }),
      secrets,
    } as never);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(createRuntime.mock.calls[0]![0].options.sandbox).toBe("bubblewrap");
  });

  it("falls back to its own credentials when the office declares none", () => {
    make({});
    expect([...createRuntime.mock.calls[0]![0].scrubKeys!]).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });
});
