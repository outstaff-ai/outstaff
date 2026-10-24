import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { RunRequest, RuntimeEvent } from "@outstaff/core";
import { sampleRunRequest } from "@outstaff/core/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSdkOptions } from "./options.js";
import { createAgentSdkRuntime } from "./runtime.js";
import { toSdkTools } from "./tools.js";
import { parseUsage } from "./messages.js";
import { assistant, codePolicy, fakeQuery, init, rateLimit, result, type Call } from "./testing.js";

const options = agentSdkOptions.parse({});
const req = (o: Partial<RunRequest> = {}): RunRequest =>
  sampleRunRequest({ policy: codePolicy(), workdir: "/work/repos/acme", ...o });

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of stream) {
    out.push(e);
  }

  return out;
}

const hookOf = (call: Call): HookCallback => call.options.hooks!.PreToolUse![0]!.hooks[0]!;
const preToolUse = (hook: HookCallback, tool_name: string, tool_input: unknown) =>
  hook(
    {
      hook_event_name: "PreToolUse",
      tool_name,
      tool_input,
      tool_use_id: "t1",
      cwd: "/work/repos/acme",
    } as never,
    "t1",
    { signal: new AbortController().signal },
  );

const decisionOf = async (hook: HookCallback, name: string, input: unknown) => {
  const out = (await preToolUse(hook, name, input)) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };

  return out.hookSpecificOutput;
};

describe("message mapping", () => {
  it("maps init, text, usage and result", async () => {
    const { query } = fakeQuery(() => [init("s1"), assistant("hello"), rateLimit(), result()]);
    const events = await collect(createAgentSdkRuntime({ options, query }).run(req()));
    expect(events.map((e) => e.type)).toEqual(["started", "text", "usage", "finished"]);
    expect(events[0]).toEqual({ type: "started", sessionId: "s1" });
    expect(events[2]).toEqual({
      type: "usage",
      windows: [
        {
          name: "five_hour",
          utilization: 0.07,
          resetsAt: new Date(1792761000 * 1000).toISOString(),
        },
        {
          name: "seven_day",
          utilization: 0.24,
          resetsAt: new Date(1793188800 * 1000).toISOString(),
        },
      ],
    });

    expect(events[3]).toEqual({ type: "finished", ok: true, text: "done", costUsd: 0.01 });
  });

  it("ignores subagent text and unknown messages", async () => {
    const sub = { ...assistant("inner"), parent_tool_use_id: "x" };
    const { query } = fakeQuery(() => [
      init("s1"),
      sub,
      { type: "stream_event" } as never,
      result(),
    ]);

    const events = await collect(createAgentSdkRuntime({ options, query }).run(req()));
    expect(events.map((e) => e.type)).toEqual(["started", "finished"]);
  });

  it("reports an error result", async () => {
    const { query } = fakeQuery(() => [
      init("s1"),
      result({
        subtype: "error_max_turns",
        is_error: true,
        result: undefined,
        errors: ["too many turns"],
      }),
    ]);

    const events = await collect(createAgentSdkRuntime({ options, query }).run(req()));
    expect(events.at(-1)).toMatchObject({ type: "finished", ok: false, error: "too many turns" });
  });

  it("marks aborted_streaming as interrupted", async () => {
    const { query } = fakeQuery(() => [
      init("s1"),
      result({
        subtype: "error_during_execution",
        is_error: true,
        result: undefined,
        terminal_reason: "aborted_streaming",
      }),
    ]);

    const events = await collect(createAgentSdkRuntime({ options, query }).run(req()));
    expect(events.at(-1)).toMatchObject({ type: "finished", ok: false, interrupted: true });
  });

  it("finishes as interrupted when the signal aborts mid-stream and the query throws", async () => {
    const controller = new AbortController();
    const { query, calls } = fakeQuery(async function* ({ options: o }) {
      yield init("s1");
      controller.abort();
      expect(o.abortController?.signal.aborted).toBe(true);
      throw new Error("aborted");
    });

    const events = await collect(
      createAgentSdkRuntime({ options, query }).run(req({ signal: controller.signal })),
    );

    expect(events.map((e) => e.type)).toEqual(["started", "finished"]);
    expect(events.at(-1)).toMatchObject({ ok: false, interrupted: true });
    expect(calls).toHaveLength(1);
  });

  it("flags a lost session when resuming fails, and only then", async () => {
    const lost = fakeQuery(async function* () {
      yield* [];
      throw new Error("No conversation found with session ID: gone-1");
    });

    const resumed = await collect(
      createAgentSdkRuntime({ options, query: lost.query }).run(req({ sessionId: "gone-1" })),
    );

    expect(resumed.at(-1)).toMatchObject({ type: "finished", ok: false, sessionLost: true });

    const fresh = await collect(createAgentSdkRuntime({ options, query: lost.query }).run(req()));

    expect(fresh.at(-1)).not.toHaveProperty("sessionLost");

    const other = fakeQuery(async function* () {
      yield* [];
      throw new Error("rate limited");
    });

    const failed = await collect(
      createAgentSdkRuntime({ options, query: other.query }).run(req({ sessionId: "s1" })),
    );

    expect(failed.at(-1)).not.toHaveProperty("sessionLost");
  });

  it("does not start a query when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { query, calls } = fakeQuery(() => []);
    const events = await collect(
      createAgentSdkRuntime({ options, query }).run(req({ signal: controller.signal })),
    );

    expect(events).toEqual([{ type: "finished", ok: false, text: "", interrupted: true }]);
    expect(calls).toHaveLength(0);
  });

  it("turns a thrown error into one failed finished event", async () => {
    const { query } = fakeQuery(async function* () {
      yield init("s1");
      throw new Error("boom");
    });

    const events = await collect(createAgentSdkRuntime({ options, query }).run(req()));
    expect(events.at(-1)).toMatchObject({ type: "finished", ok: false, error: "boom" });
    expect(events.filter((e) => e.type === "finished")).toHaveLength(1);
  });
});

describe("usage parsing", () => {
  it("ignores unknown shapes", () => {
    expect(parseUsage(null)).toBeUndefined();
    expect(parseUsage({ type: "rate_limit_event" })).toBeUndefined();
    expect(
      parseUsage({
        type: "rate_limit_event",
        rate_limit_info: { unifiedWindows: { five_hour: "x", seven_day: { utilization: "high" } } },
      }),
    ).toBeUndefined();
  });

  it("falls back to the single window of older shapes", () => {
    expect(
      parseUsage({
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1792761000 },
      }),
    ).toEqual({
      type: "usage",
      windows: [
        {
          name: "five_hour",
          utilization: 0.5,
          resetsAt: new Date(1792761000 * 1000).toISOString(),
        },
      ],
    });
  });
});

describe("options passed to the SDK", () => {
  it("sets directories, prompt, session, model, turns and isolation", async () => {
    const { query, calls } = fakeQuery(() => [init("s1"), result()]);
    const rt = createAgentSdkRuntime({
      options: agentSdkOptions.parse({ model: "opus", maxTurns: 9, claudeCodePath: "/opt/claude" }),
      query,
      env: { PATH: "/bin", ANTHROPIC_API_KEY: "secret" },
    });

    await collect(
      rt.run(
        req({
          addDirs: ["/work/memory"],
          sessionId: "prev",
          systemPrompt: "Be brief.",
          maxTurns: 3,
        }),
      ),
    );

    const o = calls[0]!.options;
    expect(o).toMatchObject({
      cwd: "/work/repos/acme",
      additionalDirectories: ["/work/memory"],
      resume: "prev",
      model: "opus",
      maxTurns: 3,
      pathToClaudeCodeExecutable: "/opt/claude",
      systemPrompt: { type: "preset", preset: "claude_code", append: "Be brief." },
      settingSources: ["project"],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true, disableBundledSkills: true },
      permissionMode: "dontAsk",
    });

    expect(o.env).toMatchObject({ PATH: "/bin", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
    expect(o.plugins).toBeUndefined();
    expect(o.skills).toEqual([]);
    expect(o.allowedTools).toBeUndefined();
  });

  it("falls back to the configured model and turns, and omits resume for a new session", async () => {
    const { query, calls } = fakeQuery(() => [init("s1"), result()]);
    await collect(
      createAgentSdkRuntime({ options: agentSdkOptions.parse({ maxTurns: 9 }), query }).run(req()),
    );

    expect(calls[0]!.options).toMatchObject({ model: "sonnet", maxTurns: 9 });
    expect(calls[0]!.options).not.toHaveProperty("resume");
    expect(calls[0]!.options).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  it("restricts built-in tools to the requested kinds", async () => {
    const { query, calls } = fakeQuery(() => [init("s1"), result()]);
    await collect(
      createAgentSdkRuntime({ options, query }).run(
        req({ builtinTools: ["read", "search", "shell"] }),
      ),
    );

    const o = calls[0]!.options;
    expect(o.tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Bash"]));
    expect(o.tools).not.toContain("Edit");
    expect(o.tools).not.toContain("Write");
    expect(o.disallowedTools).toEqual(
      expect.arrayContaining(["Edit", "Write", "WebFetch", "Task", "Agent"]),
    );

    expect(o.disallowedTools).not.toContain("Bash");
  });

  it("exposes ost tools as an in-process server named ost", async () => {
    const calls: unknown[] = [];
    const tools = [
      {
        name: "ticket_show",
        description: "Show a ticket",
        input: z.object({ key: z.string() }),
        handler: async (i: unknown, ctx: unknown) => (calls.push(i, ctx), "SHOP-1: Fix checkout"),
      },
    ];

    const { query, calls: qc } = fakeQuery(() => [init("s1"), result()]);
    await collect(createAgentSdkRuntime({ options, query }).run(req({ tools })));
    expect(qc[0]!.options.mcpServers?.["ost"]).toMatchObject({ type: "sdk", name: "ost" });

    const [def] = toSdkTools(tools, "wi-1");
    expect(def).toMatchObject({ name: "ticket_show", description: "Show a ticket" });
    expect(await def!.handler({ key: "SHOP-1" } as never, undefined)).toEqual({
      content: [{ type: "text", text: "SHOP-1: Fix checkout" }],
    });

    expect(calls).toEqual([{ key: "SHOP-1" }, { workItemId: "wi-1" }]);
  });

  it("returns handler errors to the model instead of throwing", async () => {
    const [def] = toSdkTools([
      {
        name: "x",
        description: "x",
        input: z.object({}),
        handler: async () => {
          throw new Error("nope");
        },
      },
    ]);

    expect(await def!.handler({} as never, undefined)).toEqual({
      isError: true,
      content: [{ type: "text", text: "nope" }],
    });
  });
});

describe("permission hook", () => {
  function setup() {
    let hook!: HookCallback;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { query } = fakeQuery(async function* (call) {
      hook = hookOf(call);
      yield init("s1");
      await gate;
      yield result();
    });

    return { rt: createAgentSdkRuntime({ options, query }), hook: () => hook, release };
  }

  it("denies rm, denies push to main, allows ls, and reports each decision", async () => {
    const { rt, hook, release } = setup();
    const stream = rt.run(req({ builtinTools: ["shell", "read"] }))[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.value).toMatchObject({ type: "started" });
    const h = hook();

    const rm = await decisionOf(h, "Bash", { command: "rm -rf build" });
    expect(rm.permissionDecision).toBe("deny");
    expect(rm.permissionDecisionReason).toContain("Denied by the permission policy");
    const push = await decisionOf(h, "Bash", { command: "git push origin main" });
    expect(push.permissionDecision).toBe("deny");
    const ls = await decisionOf(h, "Bash", { command: "ls" });
    expect(ls.permissionDecision).toBe("allow");
    const unknown = await decisionOf(h, "SomethingNew", {});
    expect(unknown.permissionDecision).toBe("deny");

    release();
    const rest: RuntimeEvent[] = [];
    for (let n = await stream.next(); !n.done; n = await stream.next()) {
      rest.push(n.value);
    }

    expect(rest.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_call",
      "tool_call",
      "tool_call",
      "finished",
    ]);

    const calls = rest.filter(
      (e): e is Extract<RuntimeEvent, { type: "tool_call" }> => e.type === "tool_call",
    );

    expect(calls.map((c) => [c.tool, c.decision.effect])).toEqual([
      ["Bash", "deny"],
      ["Bash", "deny"],
      ["Bash", "allow"],
      ["SomethingNew", "deny"],
    ]);

    expect(calls[0]!.input).toEqual({ command: "rm -rf build" });
  });

  it("treats ask as a denial and maps file and ost tools", async () => {
    const { rt, hook, release } = setup();
    const stream = rt.run(req())[Symbol.asyncIterator]();
    await stream.next();
    const h = hook();
    const ask = await decisionOf(h, "Bash", { command: "FOO=1 ls" });
    expect(ask.permissionDecision).toBe("deny");
    expect(ask.permissionDecisionReason).toContain("nobody is available to approve");
    expect((await decisionOf(h, "mcp__ost__ticket_show", { key: "X-1" })).permissionDecision).toBe(
      "allow",
    );

    expect((await decisionOf(h, "mcp__other__thing", {})).permissionDecision).toBe("deny");
    expect(
      (await decisionOf(h, "Read", { file_path: "/work/repos/acme/README.md" })).permissionDecision,
    ).toBe("allow");

    expect((await decisionOf(h, "Write", { file_path: "/etc/passwd" })).permissionDecision).toBe(
      "deny",
    );

    expect((await decisionOf(h, "Grep", { pattern: "x" })).permissionDecision).toBe("allow");
    expect((await decisionOf(h, "Skill", { skill: "x" })).permissionDecision).toBe("allow");
    release();
    for (let n = await stream.next(); !n.done; n = await stream.next()) {}
  });
});

describe("probeUsage", () => {
  it("runs a minimal session and returns the usage event", async () => {
    const { query, calls } = fakeQuery(() => [init("s1"), assistant("ok"), rateLimit(), result()]);
    const usage = await createAgentSdkRuntime({ options, query }).probeUsage!();
    expect(usage.windows.map((w) => w.name)).toEqual(["five_hour", "seven_day"]);
    expect(calls[0]!.options).toMatchObject({
      tools: [],
      maxTurns: 1,
      model: "haiku",
      settingSources: [],
      persistSession: false,
    });
  });

  it("fails clearly when the session reports no usage", async () => {
    const { query } = fakeQuery(() => [init("s1"), result()]);
    await expect(createAgentSdkRuntime({ options, query }).probeUsage!()).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("child process environment", () => {
  const envOf = async (config: { env: Record<string, string>; scrubKeys?: string[] }) => {
    const { query, calls } = fakeQuery(() => [init("s1"), result()]);
    await collect(createAgentSdkRuntime({ options, query, ...config }).run(req()));
    return calls[0]!.options.env!;
  };

  it("drops every declared adapter secret and keeps the rest", async () => {
    const env = await envOf({
      env: { PATH: "/bin", GH_APP_PRIVATE_KEY: "k", SLACK_BOT_TOKEN: "t", HOME: "/home/agent" },
      scrubKeys: ["GH_APP_PRIVATE_KEY", "SLACK_BOT_TOKEN"],
    });

    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/agent",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
  });

  it("always drops GH_TOKEN and GITHUB_TOKEN, and passes provider config and credential-file paths", async () => {
    const env = await envOf({
      env: {
        GH_TOKEN: "a",
        GITHUB_TOKEN: "b",
        AWS_REGION: "eu-west-1",
        CLAUDE_CODE_USE_VERTEX: "1",
        GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/outstaff/gcp.json",
      },
    });

    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).toMatchObject({
      AWS_REGION: "eu-west-1",
      CLAUDE_CODE_USE_VERTEX: "1",
      GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/outstaff/gcp.json",
    });
  });

  it("passes the runtime credential from the environment", async () => {
    const env = await envOf({
      env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-test" },
      scrubKeys: ["ANTHROPIC_API_KEY"],
    });

    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("reads the runtime credential from a secrets file, ahead of the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ost-secrets-"));
    try {
      writeFileSync(join(dir, "CLAUDE_CODE_OAUTH_TOKEN"), "oauth-from-file\n");
      writeFileSync(join(dir, "GH_APP_PRIVATE_KEY"), "pem");
      const env = await envOf({
        env: { PATH: "/bin", OUTSTAFF_SECRETS_DIR: dir, ANTHROPIC_API_KEY: "from-env" },
        scrubKeys: ["GH_APP_PRIVATE_KEY"],
      });

      expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-from-file");
      expect(env["ANTHROPIC_API_KEY"]).toBe("from-env");
      expect(env).not.toHaveProperty("GH_APP_PRIVATE_KEY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
