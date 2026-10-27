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

async function make(office: Record<string, unknown>) {
  store = await openStore("sqlite::memory:");
  return createOfficePipeline({
    team: team(office),
    store,
    workState: createStaticWorkflowState({}) as never,
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
});
