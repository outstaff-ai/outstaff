import {
  createStaticWorkflowState,
  parseTeamConfig,
  silentLogger,
  type TeamConfig,
} from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "../../clock.js";
import { openStore, type Store } from "../../store/index.js";
import { createOfficePipeline } from "../office-pipeline.js";

function team(office: Record<string, unknown>): TeamConfig {
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
    office,
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

async function make(office: Record<string, unknown>) {
  store = await openStore("sqlite::memory:");
  return createOfficePipeline({
    team: team(office),
    store,
    workState: { ...createStaticWorkflowState({}), readyTickets: () => [] } as never,
    scheduler: { enqueue: () => Promise.reject(new Error("not in this test")) },
    ports: {},
    clock: manualClock(),
    logger: silentLogger,
  });
}

describe("createOfficePipeline", () => {
  it("leaves every event to the engine when off", async () => {
    const p = await make({});
    expect([p.mode, p.runner]).toEqual(["off", undefined]);
    expect(await p.route(assigned, { source: "t", externalId: "1" }, async () => [])).toEqual([]);

    expect(await p.traces.list()).toEqual([]);
  });

  it("traces first, lets the engine judge, and adds what the engine applied to the trace in shadow mode", async () => {
    const p = await make({ pipeline: "shadow" });
    const order: string[] = [];
    const applied = [
      {
        effect: { type: "move" as const, ticket: "ACME-1", to: "active" as const },
        status: "applied" as const,
        note: "moved",
        at: "2026-10-05T09:00:00.000Z",
      },
    ];

    const result = await p.route(assigned, { source: "t", externalId: "1" }, async () => {
      order.push((await p.traces.get("t:1")) ? "traced, then engine" : "engine first");
      return applied;
    });

    expect([p.mode, result, order]).toEqual(["shadow", applied, ["traced, then engine"]]);
    expect(await p.traces.get("t:1")).toMatchObject({
      engine: { effects: [{ type: "move", ticket: "ACME-1", to: "active", as: "office" }] },
      comparison: { agree: false, differences: [{ kind: "missing_in_pipeline" }] },
    });
  });

  it("judges without the engine when live", async () => {
    const live = await make({ pipeline: "live" });
    expect(live.mode).toBe("live");
    let engine = false;
    await live.route({ ...assigned, subject: {} }, { source: "t", externalId: "2" }, async () => {
      engine = true;
      return [];
    });

    expect(engine).toBe(false);
    expect(await live.traces.get("t:2")).toBeDefined();
  });

  it("leaves an idle agent to the scheduler's pull when off, traces it first in shadow mode", async () => {
    const off = await make({});
    expect(await off.idle(idle, async () => "pulled")).toBe("pulled");
    expect(await off.traces.list()).toEqual([]);

    const shadow = await make({ pipeline: "shadow" });
    const order: string[] = [];
    await shadow.idle(idle, async () => {
      order.push((await shadow.traces.get(idle.id)) ? "traced, then pulled" : "pulled first");
    });

    expect(order).toEqual(["traced, then pulled"]);
  });

  it("judges an idle agent without the scheduler's pull when live", async () => {
    const live = await make({ pipeline: "live" });
    let pulled = false;
    await live.idle(idle, async () => (pulled = true));
    expect(pulled).toBe(false);
    expect((await live.traces.get(idle.id))?.decisions).toEqual([
      { type: "drop", policy: "idle_pulls_next", reason: "no ready ticket is assigned to sam" },
    ]);
  });
});
