import {
  createFakeTracker,
  createFakeVcs,
  type FakeTracker,
  type FakeVcs,
} from "@outstaff/core/fakes";
import type { WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { REPO, teamConfig } from "#/intake/__tests__/test-support.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import type { HeardEvent, WorkState } from "#/workstate/index.js";
import { createWorkState } from "#/workstate/workstate.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const meta = { source: "tracker" as const, externalId: "e", trusted: true };
const SAM = { kind: "agent", id: "sam" };
const NOOR = { kind: "agent", id: "noor" };
const ADA = { kind: "human", id: "ada.admin" };

describe("silent hand-backs in the work state", () => {
  let clock: ManualClock;
  let store: Store;
  let tracker: FakeTracker;
  let vcs: FakeVcs;
  let ws: WorkState;

  const build = async () => {
    ws = await createWorkState({
      store,
      ports: { vcs, tracker },
      team: teamConfig(),
      clock,
      logger: silent,
    });
  };

  const heard = (
    type: string,
    ticket: string | undefined,
    actor = SAM,
    data: Record<string, unknown> = {},
  ): Promise<void> =>
    ws.heard({
      type,
      at: clock.now().toISOString(),
      actor,
      subject: ticket ? { ticket } : {},
      data,
    } satisfies HeardEvent);

  const silentBack = (ticket: string, actor = SAM) =>
    heard("agent.handed_back", ticket, actor, { status: "silent" });

  /** A ready ticket for sam, as the work state reads it. */
  const ready = async (extra: { parent?: string } = {}) => {
    const t = await tracker.createIssue({
      title: "Search page",
      body: "",
      status: "ready",
      assignee: "u-sam",
      ...extra,
    });

    const event: WorkflowEvent = {
      type: "ticket.created",
      subject: { ticket: t.key },
      actor: ADA as WorkflowEvent["actor"],
      data: { at: clock.now().toISOString() },
    };

    await ws.apply(event, meta);
    return t.key;
  };

  beforeEach(async () => {
    clock = manualClock("2030-01-01T08:00:00.000Z");
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    tracker = createFakeTracker({
      now: clock.now,
      actor: { id: "u-sam", name: "Sam", kind: "agent" },
    });

    vcs = createFakeVcs({ now: clock.now });
    await build();
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  it("holds a ticket the agent handed back silent, for that agent only, and keeps it over a restart", async () => {
    const key = await ready();
    await silentBack(key);
    const at = "2030-01-01T08:00:00.000Z";
    expect(ws.silencedAt(key, "sam")).toBe(at);
    expect(ws.silencedAt(key, "noor")).toBeUndefined();
    expect(ws.readyTickets("sam")).toMatchObject([{ key, silencedAt: at }]);

    await ws.stop();
    await build();
    expect(ws.silencedAt(key, "sam")).toBe(at);
  });

  it("is not released by the agent's own events: the restore's echo, its start, its comment, its idle pull", async () => {
    const key = await ready();
    await silentBack(key);
    await heard("ticket.moved", key, SAM, { echo: "office:act" });
    await heard("agent.started", key);
    await heard("ticket.commented", key);
    await heard("agent.idle", undefined);
    expect(ws.silencedAt(key, "sam")).toBeDefined();
  });

  it("is released by anyone else acting on the ticket: a human, a teammate, the office's own events", async () => {
    for (const actor of [ADA, NOOR, { kind: "automation", id: "workstate" }]) {
      const key = await ready();
      await silentBack(key);
      await silentBack(key, NOOR);
      await heard("ticket.commented", key, actor);
      expect(ws.silencedAt(key, "sam")).toBeUndefined();
      expect(ws.silencedAt(key, "noor")).toBe(
        actor === NOOR ? clock.now().toISOString() : undefined,
      );
    }
  });

  it("is released for a parent by a change on one of its sub-tickets, and holds a ready sub-ticket with it", async () => {
    const parent = await tracker.createIssue({ title: "Parent", body: "", status: "active" });
    const sub = await ready({ parent: parent.key });
    await silentBack(parent.key);
    expect(ws.readyTickets("sam")).toMatchObject([{ key: sub, silencedAt: expect.any(String) }]);

    await heard("ticket.moved", sub, ADA);
    expect(ws.silencedAt(parent.key, "sam")).toBeUndefined();
    expect(ws.readyTickets("sam")[0]).not.toHaveProperty("silencedAt");
  });

  it("is released by the agent's own hand-back that is not silent, and by a round a human asked for in chat", async () => {
    const key = await ready();
    await silentBack(key);
    await heard("agent.handed_back", key, SAM, { status: "blocked" });
    expect(ws.silencedAt(key, "sam")).toBeUndefined();

    await silentBack(key);
    await heard("agent.started", key, SAM, { fromChat: true });
    expect(ws.silencedAt(key, "sam")).toBeUndefined();
  });

  it("is released when the ticket closed, whoever closed it", async () => {
    const key = await ready();
    await silentBack(key);
    await tracker.transition(key, "done");
    await ws.refreshTicket(key);
    await heard("ticket.moved", key);
    expect(ws.silencedAt(key, "sam")).toBeUndefined();
  });

  it("reads a pull request's event as one on its ticket, and ignores events on nothing it knows", async () => {
    const key = await ready();
    const p = await vcs.seed.pullRequest(REPO, {
      title: "Add search",
      author: { login: "acme-sam[bot]", kind: "agent" },
      head: { ref: `sam/${key.toLowerCase()}-search` },
    });

    const opened: WorkflowEvent = {
      type: "pr.opened",
      subject: { pr: { repo: REPO, number: p.number } },
      actor: { kind: "agent", id: "sam" },
      data: {},
    };

    await ws.apply(opened, { ...meta, source: "vcs" });
    await silentBack(key);
    const review = (number: number): HeardEvent => ({
      type: "pr.review_submitted",
      at: clock.now().toISOString(),
      actor: ADA,
      subject: { pr: { repo: REPO, number } },
      data: {},
    });

    await ws.heard(review(p.number + 100));
    await heard("ticket.commented", "ACME-999", ADA);
    expect(ws.silencedAt(key, "sam")).toBeDefined();

    await ws.heard(review(p.number));
    expect(ws.silencedAt(key, "sam")).toBeUndefined();
  });
});
