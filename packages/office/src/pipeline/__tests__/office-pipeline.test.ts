import {
  createStaticWorkflowState,
  parseTeamConfig,
  silentLogger,
  type TeamConfig,
} from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { openStore, type Store } from "#/store/index.js";
import { createOfficePipeline } from "#/pipeline/office-pipeline.js";

function team(): TeamConfig {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "shop", url: "github.com/acme-example/shop", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer", model: "sonnet" }],
    integrations: {
      chat: { adapter: "slack" },
      vcs: { adapter: "github" },
      runtime: { adapter: "claude-agent-sdk" },
    },
  });

  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
}

let store: Store | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

const assigned = {
  type: "ticket.assigned" as const,
  subject: { ticket: "ACME-1" },
  actor: { kind: "human" as const, id: "ada.admin" },
  data: {},
};

const idle = {
  id: "office:idle:sam:2026-10-05T09:00:00.000Z",
  type: "agent.idle" as const,
  at: "2026-10-05T09:00:00.000Z",
  subject: {},
  actor: { kind: "agent" as const, id: "sam" },
  data: {},
};

async function make() {
  store = await openStore("sqlite::memory:");
  return createOfficePipeline({
    team: team(),
    store,
    workState: { ...createStaticWorkflowState({}), readyTickets: () => [] } as never,
    scheduler: { enqueue: () => Promise.reject(new Error("not in this test")) },
    ports: {},
    clock: manualClock(),
    logger: silentLogger,
  });
}

describe("createOfficePipeline", () => {
  it("judges an event and records its trace", async () => {
    const p = await make();
    const trace = await p.runner.handle(
      { ...assigned, subject: {} },
      { source: "t", externalId: "2" },
    );

    expect(trace?.event.id).toBe("t:2");
    expect(await p.traces.get("t:2")).toBeDefined();
  });

  it("judges an idle agent", async () => {
    const p = await make();
    await p.runner.judge(idle);
    expect((await p.traces.get(idle.id))?.decisions).toEqual([
      { type: "drop", policy: "idle_pulls_next", reason: "no ready ticket is assigned to sam" },
    ]);
  });

  it("queues the wake a chat message decides, through the scheduler", async () => {
    const message = {
      type: "chat.message" as const,
      subject: { chat: { channel: "D-1" } },
      actor: { kind: "human" as const, id: "U-ADA" },
      data: { body: "hi", addressed: "sam" },
    };

    const p = await make();
    await expect(p.runner.handle(message, { source: "chat", externalId: "4" })).rejects.toThrow(
      "not in this test",
    );

    expect((await p.traces.get("chat:4"))?.decisions).toMatchObject([
      { type: "wake", person: "sam", kind: "chat" },
    ]);
  });
});
