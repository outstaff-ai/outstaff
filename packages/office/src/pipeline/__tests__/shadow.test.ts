import {
  createStaticWorkflowState,
  parseTeamConfig,
  type Logger,
  type TeamConfig,
} from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { manualClock } from "../../clock.js";
import { createMemoryTraceStore } from "../memory-traces.js";
import { createShadowPipeline } from "../shadow.js";
import type { TraceStore } from "../trace.types.js";

function team(pipeline?: unknown): TeamConfig {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "shop", url: "github.com/acme-example/shop", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer" }],
    integrations: {
      chat: { adapter: "slack" },
      vcs: { adapter: "github" },
      runtime: { adapter: "claude-agent-sdk" },
    },
    office: { pipeline: "shadow" },
    ...(pipeline ? { pipeline } : {}),
  });

  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
}

const recordingLogger = () => {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (m) => lines.push(`debug ${m}`),
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };

  return { lines, logger };
};

const state = createStaticWorkflowState({
  tickets: { "ACME-1": { status: "ready", assignee: { id: "sam", kind: "agent" } } },
});

const assigned = {
  type: "ticket.assigned" as const,
  subject: { ticket: "ACME-1" },
  actor: { kind: "human" as const, id: "ada.admin" },
  data: {},
};

describe("createShadowPipeline", () => {
  it("records what the pipeline would decide, and nothing else", async () => {
    const traces = createMemoryTraceStore();
    const { lines, logger } = recordingLogger();
    const shadow = createShadowPipeline({
      team: team(),
      state,
      traces,
      clock: manualClock(),
      logger,
    });

    const trace = await shadow.handle(assigned, { source: "tracker", externalId: "e-1" });
    expect(trace?.decisions).toMatchObject([{ type: "wake", person: "sam", kind: "assigned" }]);
    expect(await traces.get("tracker:e-1")).toEqual(trace);
    expect(lines).toEqual(["debug pipeline (shadow): ticket.assigned tracker:e-1"]);
  });

  it("decides no idle pull, since the work state does not know when tickets became ready", async () => {
    const traces = createMemoryTraceStore();
    const shadow = createShadowPipeline({
      team: team(),
      state,
      traces,
      clock: manualClock(),
      logger: recordingLogger().logger,
    });

    const idle = {
      ...assigned,
      type: "agent.idle" as never,
      actor: { kind: "agent" as const, id: "sam" },
    };

    expect(
      (await shadow.handle(idle, { source: "office", externalId: "idle-1" }))?.decisions,
    ).toEqual([
      { type: "drop", policy: "idle_pulls_next", reason: "no ready ticket is assigned to sam" },
    ]);
  });

  it("skips event types it does not decide on", async () => {
    const traces = createMemoryTraceStore();
    const shadow = createShadowPipeline({
      team: team(),
      state,
      traces,
      clock: manualClock(),
      logger: recordingLogger().logger,
    });

    expect(
      await shadow.handle(
        { ...assigned, type: "schedule.cron" },
        { source: "office", externalId: "c" },
      ),
    ).toBeUndefined();

    expect(await traces.list()).toEqual([]);
  });

  it("adds what the engine applied to the event's trace, compared with the pipeline's decisions", async () => {
    const traces = createMemoryTraceStore();
    const shadow = createShadowPipeline({
      team: team(),
      state,
      traces,
      clock: manualClock(),
      logger: recordingLogger().logger,
    });

    const meta = { source: "tracker", externalId: "e-3" };
    await shadow.handle(assigned, meta);
    const schedule = {
      type: "schedule" as const,
      person: "sam",
      kind: "assigned",
      priority: "normal" as const,
      ticket: "ACME-1",
    };

    const done = await shadow.engineDid(meta, [
      { effect: schedule, status: "applied", note: "queued", at: "2026-10-05T09:00:00.000Z" },
    ]);

    expect(done).toMatchObject({
      engine: {
        effects: [
          {
            type: "wake",
            person: "sam",
            kind: "assigned",
            subject: { type: "ticket", ref: "ACME-1" },
          },
        ],
      },
      comparison: { agree: true, differences: [] },
    });

    expect(await traces.get("tracker:e-3")).toEqual(done);
    expect(await shadow.engineDid({ source: "tracker", externalId: "none" }, [])).toBeUndefined();
  });

  it("logs, and does not throw, when the engine's side cannot be recorded", async () => {
    const { lines, logger } = recordingLogger();
    const broken: TraceStore = {
      ...createMemoryTraceStore(),
      get: () => Promise.reject(new Error("disk")),
    };

    const shadow = createShadowPipeline({
      team: team(),
      state,
      traces: broken,
      clock: manualClock(),
      logger,
    });

    expect(await shadow.engineDid({ source: "t", externalId: "1" }, [])).toBeUndefined();
    expect(lines).toEqual(["warn pipeline (shadow) could not record what the engine did"]);
  });

  it("logs configuration issues once, and a failure without throwing", async () => {
    const { lines, logger } = recordingLogger();
    const broken: TraceStore = {
      ...createMemoryTraceStore(),
      record: () => Promise.reject(new Error("disk full")),
    };

    const shadow = createShadowPipeline({
      team: team({ policies: { nope: { enabled: false } } }),
      state,
      traces: broken,
      clock: manualClock(),
      logger,
    });

    expect(await shadow.handle(assigned, { source: "tracker", externalId: "e-2" })).toBeUndefined();
    expect(lines).toEqual([
      "warn pipeline: pipeline.policies.nope: no policy has this id",
      "warn pipeline (shadow) failed on an event",
    ]);
  });
});
