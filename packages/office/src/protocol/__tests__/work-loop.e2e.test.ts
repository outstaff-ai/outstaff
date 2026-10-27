import { createOfficeConnection, createWorkLoop, type AgentEnv } from "@outstaff/agent";
import { buildPolicy, type TeamConfig } from "@outstaff/core";
import { createFakeRuntime } from "@outstaff/core/fakes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "../../clock.js";
import { createAgentAuth } from "../auth.js";
import { createProtocolServer } from "../server.js";
import { createFakeSource, type FakeSource } from "@outstaff/testing.office";
import type { ProtocolServer } from "../types.js";

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  if (!cond()) {
    throw new Error("condition not reached");
  }
};

describe("the agent work loop against the real protocol server", () => {
  let source: FakeSource;
  let server: ProtocolServer;

  beforeEach(async () => {
    source = createFakeSource();
    server = createProtocolServer({
      source,
      auth: createAgentAuth({ sam: "sam-token" }),
      clock: manualClock(),
      port: 0,
      host: "127.0.0.1",
      pollMs: 20,
    });

    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("runs an offered item, stores its session in the office and hands back", async () => {
    const conn = createOfficeConnection({
      url: `ws://127.0.0.1:${server.port()}/agent`,
      person: "sam",
      token: "sam-token",
      agentVersion: "test",
    });

    const team = { people: [{ handle: "sam", repos: {} }], repos: [] } as unknown as TeamConfig;
    const env = { person: "sam", team } as AgentEnv;
    const runtime = createFakeRuntime();
    runtime.enqueue([{ type: "finish", text: "Done: https://git.acme.example/pull/1" }]);
    const loop = createWorkLoop({
      office: conn,
      runtime,
      env: { ...env, office: conn },
      systemPrompt: "x",
      policy: buildPolicy({
        profile: "readonly",
        person: team.people[0]!,
        team,
        layout: {
          home: "/h",
          workDir: "/h/work",
          reposDir: "/h/repos",
          worktreesDir: "/h/worktrees",
          scratchDir: "/h/scratch",
          memoryDir: "/h/memory",
          secretsDir: "/run/secrets",
        },
      }),
      builtinTools: ["read"],
      workdir: "/h/work",
      addDirs: [],
    });

    source.enqueue("sam", "w1", "Fix checkout");
    conn.start();
    await conn.whenConnected();
    server.notify("sam");
    const running = loop.run();
    await until(() => source.stateOf("w1") === "done");

    expect(source.sessions.get("w1")).toBe("fake-session-1");
    expect(source.handBacks[0]).toMatchObject({
      id: "w1",
      status: "done",
      links: [{ url: "https://git.acme.example/pull/1" }],
    });

    // Another item arrives with a session stored by an earlier round; the runtime resumes it.
    source.enqueue("sam", "w2", "Review feedback");
    await source.setSession("sam", "w2", "stored-2");
    server.notify("sam");
    await until(() => source.stateOf("w2") === "done");
    // Each hand-back also asks for a journal entry (one turn, no tools) in the same session.
    const rounds = runtime.requests.filter((r) => r.maxTurns !== 1);
    expect(rounds[0]?.sessionId).toBeUndefined();
    expect(rounds[1]?.sessionId).toBe("stored-2");
    await loop.stop();
    await conn.stop();
    await running;
  });

  it("puts an accepted item back in the queue untouched after a restart", async () => {
    const team = { people: [{ handle: "sam", repos: {} }], repos: [] } as unknown as TeamConfig;
    source.enqueue("sam", "w3", "Half done");
    await source.next("sam");
    await source.accept("sam", "w3");
    source.calls.length = 0;

    const conn = createOfficeConnection({
      url: `ws://127.0.0.1:${server.port()}/agent`,
      person: "sam",
      token: "sam-token",
      agentVersion: "test",
    });

    const loop = createWorkLoop({
      office: conn,
      runtime: createFakeRuntime(),
      env: { person: "sam", team } as AgentEnv,
      systemPrompt: "x",
      policy: buildPolicy({
        profile: "readonly",
        person: team.people[0]!,
        team,
        layout: {
          home: "/h",
          workDir: "/h/work",
          reposDir: "/h/repos",
          worktreesDir: "/h/worktrees",
          scratchDir: "/h/scratch",
          memoryDir: "/h/memory",
          secretsDir: "/run/secrets",
        },
      }),
      builtinTools: ["read"],
      workdir: "/h/work",
      addDirs: [],
    });

    conn.start();
    await conn.whenConnected();
    const running = loop.run();
    await until(() => source.calls.includes("decline:sam:w3"));
    expect(source.calls.some((c) => c.startsWith("fail:"))).toBe(false);
    await loop.stop();
    await conn.stop();
    await running;
  });
});
