import { expect, it } from "vitest";
import { buildPolicy } from "../permissions/index.js";
import type { RunRequest, Runtime, RuntimeEvent } from "../ports/index.js";
import type { RuntimeSeed } from "./seeds.js";
import { contractSuite, requireCapability, requireSeed, type ContractSetupFn } from "./harness.js";

const layout = {
  home: "/home/agent",
  workDir: "/home/agent/work",
  reposDir: "/home/agent/repos",
  worktreesDir: "/home/agent/worktrees",
  scratchDir: "/home/agent/scratch",
  memoryDir: "/home/agent/memory",
  secretsDir: "/home/agent/secrets",
};

export function sampleRunRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    prompt: "Say hello.",
    systemPrompt: "You are a helpful agent.",
    workdir: "/home/agent/scratch",
    addDirs: [],
    policy: buildPolicy({
      profile: "readonly",
      person: { repos: {} },
      team: { repos: [] },
      layout,
    }),
    tools: [],
    builtinTools: ["read"],
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of stream) {
    out.push(e);
  }

  return out;
}

export function runtimeContract(name: string, setup: ContractSetupFn<Runtime, RuntimeSeed>): void {
  contractSuite(`runtime contract: ${name}`, setup, (get) => {
    it("starts with a session id and ends with exactly one finished event", async (t) => {
      const s = get();
      requireCapability(t, s, "runtime.sessions");
      await requireSeed(t, s.seed, "script")("hello");
      const events = await collect(s.subject.run(sampleRunRequest()));
      expect(events[0]?.type).toBe("started");
      const started = events[0] as Extract<RuntimeEvent, { type: "started" }>;
      expect(started.sessionId).toBeTruthy();
      expect(events.filter((e) => e.type === "finished")).toHaveLength(1);
      const last = events[events.length - 1] as Extract<RuntimeEvent, { type: "finished" }>;
      expect(last.type).toBe("finished");
      expect(last.ok).toBe(true);
      expect(last.text).toContain("hello");
    });

    it("keeps the session id when resuming", async (t) => {
      const s = get();
      requireCapability(t, s, "runtime.sessions");
      const script = requireSeed(t, s.seed, "script");
      await script("first");
      const first = (await collect(s.subject.run(sampleRunRequest())))[0] as Extract<
        RuntimeEvent,
        { type: "started" }
      >;

      await script("second");
      const second = (
        await collect(s.subject.run(sampleRunRequest({ sessionId: first.sessionId })))
      )[0] as Extract<RuntimeEvent, { type: "started" }>;

      expect(second.sessionId).toBe(first.sessionId);
    });

    it("finishes as interrupted when the signal is already aborted", async (t) => {
      const s = get();
      requireCapability(t, s, "runtime.sessions");
      await requireSeed(t, s.seed, "script")("never said");
      const controller = new AbortController();
      controller.abort();
      const events = await collect(s.subject.run(sampleRunRequest({ signal: controller.signal })));
      const last = events[events.length - 1];
      expect(last).toMatchObject({ type: "finished", ok: false, interrupted: true });
    });

    it("probes usage windows", async (t) => {
      const s = get();
      requireCapability(t, s, "runtime.usage");
      expect(s.subject.probeUsage).toBeTypeOf("function");
      const usage = await s.subject.probeUsage!();
      expect(usage.type).toBe("usage");
      expect(usage.windows.length).toBeGreaterThan(0);
      for (const w of usage.windows) {
        expect(w.name).toBeTruthy();
        expect(w.utilization).toBeGreaterThanOrEqual(0);
      }
    });
  });
}
