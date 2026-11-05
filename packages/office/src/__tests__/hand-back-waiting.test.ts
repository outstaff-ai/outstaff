import type { TeamConfig } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { officeWaitingOn } from "#/hand-back-waiting.js";
import { createScheduler } from "#/scheduler/index.js";
import { openStore } from "#/store/open.js";
import type { Store, WorkItem } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import type { HandBackResult } from "#/work-source.types.js";
import { schedulerWorkSource } from "#/work-source.js";
import type { PrRecord, TicketRecord } from "#/workstate/index.js";

const team = {
  people: [],
  policies: {
    agent_loop_guard: { max_runs_per_subject_per_hour: 12 },
    usage: { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 },
    retry: { base_minutes: 1, cap_minutes: 30, max_failures: 2 },
  },
} as unknown as Pick<TeamConfig, "people" | "humans" | "policies">;

const pr = (title: string, state: PrRecord["state"], draft = false) =>
  ({ title, state, draft }) as PrRecord;

const agent = (id: string) => ({ id, kind: "agent" as const });
const human = (id: string) => ({ id, kind: "human" as const });

/** The work state as the check reads it: tickets by key, their parents, and the pull requests of each. */
function workStateOf() {
  const tickets = new Map<string, Partial<TicketRecord>>();
  const prs = new Map<string, PrRecord[]>();
  const refreshed: [string, unknown][] = [];
  return {
    tickets,
    prs,
    refreshed,
    ticket: (key: string) => tickets.get(key) as TicketRecord | undefined,
    prsOfTicket: (key: string) => prs.get(key) ?? [],
    subTickets: (key: string) => [...tickets].filter(([, t]) => t.parent === key).map(([k]) => k),
    repoPrs: () => [],
    refreshTicket: async (key: string, by?: unknown) => void refreshed.push([key, by]),
    refreshPrsOf: async () => {},
  };
}

/** ACME-48 active with sam: the parent of the cases below. */
const parent = (state: ReturnType<typeof workStateOf>) =>
  state.tickets.set("ACME-48", { status: "active", assignee: agent("sam") });

describe("officeWaitingOn", () => {
  let store: Store;
  let clock: ManualClock;
  let state: ReturnType<typeof workStateOf>;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite://:memory:", { now: () => clock.now() });
    state = workStateOf();
  });

  afterEach(async () => {
    await store.close();
  });

  async function item(subject?: { type: string; ref: string }): Promise<WorkItem> {
    const scheduler = createScheduler({ store, team, clock });
    return scheduler.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Fix",
      trigger: "human",
      ...(subject ? { subject } : {}),
    });
  }

  const check = async () =>
    officeWaitingOn({ store, workState: state })(await item({ type: "ticket", ref: "ACME-48" }));

  it("waits on a parent whose open sub-tickets are in review or with an agent, after re-reading them", async () => {
    parent(state);
    state.tickets.set("ACME-49", { status: "review", assignee: human("ada"), parent: "ACME-48" });
    state.tickets.set("ACME-50", { status: "backlog", assignee: agent("sam"), parent: "ACME-48" });
    state.tickets.set("ACME-51", { status: "done", parent: "ACME-48" });
    expect(await check()).toEqual(["ACME-49 is in review", "ACME-50 is with sam"]);

    expect(state.refreshed).toEqual([
      ["ACME-48", { kind: "agent", id: "sam" }],
      ["ACME-49", undefined],
      ["ACME-50", undefined],
      ["ACME-51", undefined],
    ]);
  });

  it("waits on a ticket whose own pull request is open for a human's review", async () => {
    parent(state);
    state.prs.set("ACME-48", [pr("Search", "open"), pr("Old", "merged")]);
    expect(await check()).toEqual(["pull request Search is open for review"]);
  });

  it("waits on nothing, a real block, when nothing is open or anything open is not in flight", async () => {
    parent(state);
    expect(await check()).toEqual([]);

    state.prs.set("ACME-48", [pr("Search", "open", true)]);
    expect(await check()).toEqual([]);

    state.prs.set("ACME-48", [pr("Search", "open")]);
    state.tickets.set("ACME-49", { status: "active", assignee: human("ada"), parent: "ACME-48" });
    expect(await check()).toEqual([]);

    state.tickets.set("ACME-49", { parent: "ACME-48" });
    expect(await check()).toEqual([]);
  });

  it("waits on nothing for a ticket that is blocked or closed, or an item without a ticket", async () => {
    state.tickets.set("ACME-48", { status: "blocked" });
    state.prs.set("ACME-48", [pr("Search", "open")]);
    expect(await check()).toEqual([]);

    state.tickets.set("ACME-48", { status: "done" });
    expect(await check()).toEqual([]);

    expect(await officeWaitingOn({ store, workState: state })(await item())).toEqual([]);
  });
});

describe("work source: a blocked hand-back that waits on work in flight", () => {
  let store: Store;
  let clock: ManualClock;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite://:memory:", { now: () => clock.now() });
  });

  afterEach(async () => {
    await store.close();
  });

  async function handBack(
    status: "blocked" | "silent",
    setUp: (s: ReturnType<typeof workStateOf>) => void,
  ) {
    const warned: string[] = [];
    const handed: HandBackResult[] = [];
    const state = workStateOf();
    setUp(state);
    const scheduler = createScheduler({ store, team, clock });
    const source = schedulerWorkSource({
      scheduler,
      store,
      team,
      workState: state,
      logger: { warn: (m: string) => void warned.push(m) },
      onHandedBack: async (_item, result) => void handed.push(result),
    });

    await scheduler.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Fix",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-48" },
    });

    const offer = await source.next("sam");
    const id = offer!.workItem.id;
    await source.handBack("sam", id, { summary: "Waiting on the review.", links: [], status });
    return { item: (await store.getItem(id))!, warned, handed };
  }

  const inFlight = (s: ReturnType<typeof workStateOf>) => {
    parent(s);
    s.tickets.set("ACME-49", { status: "review", assignee: human("ada"), parent: "ACME-48" });
    s.tickets.set("ACME-50", { status: "ready", assignee: agent("sam"), parent: "ACME-48" });
  };

  it("is taken as silent: the item ends done, and the hand-back names what it waits on", async () => {
    const { item, warned, handed } = await handBack("blocked", inFlight);
    expect(item.status).toBe("done");
    expect(handed[0]).toMatchObject({
      status: "silent",
      waitingOn: ["ACME-49 is in review", "ACME-50 is with sam"],
    });

    expect(warned).toEqual([
      "a blocked hand-back waits on work in flight (ACME-49 is in review; ACME-50 is with sam); taking it as silent",
    ]);
  });

  it("still escalates a real block: nothing in flight", async () => {
    const { item, warned } = await handBack("blocked", parent);
    expect(item.status).toBe("blocked");
    expect(warned).toEqual([]);
  });

  it("lets ticket work finish silently only while it waits on work in flight", async () => {
    expect((await handBack("silent", inFlight)).item.status).toBe("done");
    const { item, warned } = await handBack("silent", parent);
    expect(item.status).toBe("blocked");
    expect(warned).toEqual([
      "a silent hand-back of ticket work waits on nothing in flight; taking it as blocked",
    ]);
  });
});
