import type { Logger } from "@outstaff/core";
import type { QueuedAct } from "@outstaff/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { openStore, type Store } from "#/store/index.js";
import type { Act } from "#/pipeline/decisions.types.js";
import { createMemoryTraceStore } from "#/pipeline/memory-traces.js";
import type { Trace } from "#/pipeline/trace.types.js";
import { createAgentActExecutor } from "#/pipeline/act/agent-executor.js";
import { createActDesk } from "#/pipeline/act/desk.js";
import { actId, actRecords } from "#/pipeline/act/results.js";

const AT = "2030-01-01T00:00:00.000Z";

const act = (ticket = "ACME-1", note?: string): Act => ({
  type: "act",
  policy: "hand_back_done",
  as: "sam",
  ops: [{ op: "move", ticket, to: "review" }],
  ...(note ? { note } : {}),
});

const trace = (id: string): Trace => ({
  event: {
    id,
    type: "agent.handed_back",
    at: "2026-10-05T09:00:00.000Z",
    subject: { ticket: "ACME-1" },
    actor: { kind: "agent", id: "sam" },
    data: {},
  },
  policies: [],
  decisions: [act()],
});

let store: Store | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

/** A desk whose agent `sam` is connected while `online` is true; what was sent and refreshed is recorded. */
async function harness(opts: { refresh?: (key: string) => Promise<void> } = {}) {
  store = await openStore("sqlite::memory:");
  const clock = manualClock();
  const traces = createMemoryTraceStore();
  const pushed: { person: string; act: QueuedAct }[] = [];
  const refreshed: string[] = [];
  const warned: string[] = [];
  const logger: Logger = { debug() {}, info() {}, warn: (m) => void warned.push(m), error() {} };
  const state = { online: true };
  const desk = createActDesk({
    store,
    traces,
    clock,
    logger,
    workState: {
      refreshTicket: async (key) => {
        refreshed.push(key);
        await opts.refresh?.(key);
      },
    },
    push: (person, a) => state.online && pushed.push({ person, act: a }) > 0,
  });

  const exec = createAgentActExecutor({ traces, acts: desk });

  /** The record of the act of `hand_back_done` on the event's trace. */
  const recordOf = async (event: string) =>
    (await traces.get(event))?.results?.[`${event}:hand_back_done`];

  return { desk, exec, traces, clock, pushed, refreshed, warned, state, recordOf };
}

describe("actRecords", () => {
  it("changes the record of an act on its trace, and nothing for an event without one", async () => {
    const traces = createMemoryTraceStore();
    await traces.record(trace("e"));
    const update = actRecords(traces);
    await update("e", actId("e", "p"), () => ({ status: "queued", queuedAt: AT, results: [] }));
    await update("e", "e:q", () => undefined);
    await update("missing", "x", () => ({ status: "queued", queuedAt: AT, results: [] }));
    expect((await traces.get("e"))?.results).toEqual({
      "e:p": { status: "queued", queuedAt: AT, results: [] },
    });

    expect(await traces.get("missing")).toBeUndefined();

    // A re-evaluated event keeps its acts' records.
    await traces.record(trace("e"));
    expect(Object.keys((await traces.get("e"))?.results ?? {})).toEqual(["e:p"]);
  });
});

describe("the agent act executor", () => {
  it("sends a connected agent its act at once, records the agent's answer and reads the ticket again", async () => {
    const h = await harness();
    await h.traces.record(trace("e"));
    await h.exec.execute(act("ACME-1", "Moved to review."), "e");
    await h.exec.execute(act("ACME-1", "Moved to review."), "e");

    const ops = [
      { op: "move", ticket: "ACME-1", to: "review" },
      { op: "comment", on: { ticket: "ACME-1" }, body: "Moved to review." },
    ];

    expect(h.pushed).toEqual([{ person: "sam", act: { id: "e:hand_back_done", ops } }]);
    expect((await h.traces.get("e"))?.results).toEqual({
      "e:hand_back_done": { status: "delivered", queuedAt: AT, deliveredAt: AT, results: [] },
    });

    h.clock.advance(5_000);
    const results = ["moved ACME-1 to review", "commented on ACME-1"];
    await h.desk.result("sam", { id: "e:hand_back_done", ok: true, results });
    expect(await h.recordOf("e")).toEqual({
      status: "done",
      queuedAt: AT,
      deliveredAt: AT,
      finishedAt: "2030-01-01T00:00:05.000Z",
      results,
    });

    expect(h.refreshed).toEqual(["ACME-1"]);
    // Answered: not handed over again, and a repeated answer changes nothing.
    expect(await h.desk.deliver("sam")).toEqual([]);
    await h.desk.result("sam", { id: "e:hand_back_done", ok: false, results: [] });
    expect((await h.recordOf("e"))?.status).toBe("done");
  });

  it("queues the act of an offline agent for its next welcome, and records a failure", async () => {
    const h = await harness({ refresh: () => Promise.reject(new Error("tracker down")) });
    h.state.online = false;
    await h.traces.record(trace("e"));
    await h.exec.execute(act("ACME-404"), "e");
    expect(h.pushed).toEqual([]);
    expect((await h.recordOf("e"))?.status).toBe("queued");

    const ops = [{ op: "move", ticket: "ACME-404", to: "review" }];
    expect(await h.desk.deliver("sam")).toEqual([{ id: "e:hand_back_done", ops }]);
    expect(await h.desk.deliver("mira")).toEqual([]);
    expect((await h.recordOf("e"))?.status).toBe("delivered");

    // Another agent cannot answer it.
    await h.desk.result("mira", { id: "e:hand_back_done", ok: true, results: [] });
    expect((await h.recordOf("e"))?.status).toBe("delivered");

    const error = "move ACME-404: Issue ACME-404 not found.";
    await h.desk.result("sam", { id: "e:hand_back_done", ok: false, results: [], error });
    expect(await h.recordOf("e")).toMatchObject({
      status: "failed",
      results: [],
      error,
    });

    expect(h.warned).toEqual([
      "could not read a ticket an act changed",
      "act e:hand_back_done of sam failed",
    ]);
  });

  it("adds no note without a ticket, and records nothing for an act outside the pipeline", async () => {
    const h = await harness();
    await h.traces.record(trace("f"));
    const docOnly: Act = {
      type: "act",
      policy: "p",
      as: "sam",
      ops: [{ op: "comment", on: { doc: "doc-7" }, body: "x" }],
      note: "For sam.",
    };

    await h.exec.execute(docOnly, "f");
    expect(h.pushed[0]?.act.ops).toEqual(docOnly.ops);

    await h.desk.send("sam", { id: "question:1", ops: docOnly.ops });
    await h.desk.result("sam", { id: "f:p", ok: true, results: ["commented on doc doc-7"] });
    await h.desk.result("sam", { id: "question:1", ok: true, results: ["commented on doc doc-7"] });
    expect(h.refreshed).toEqual([]);
    expect(Object.keys((await h.traces.get("f"))?.results ?? {})).toEqual(["f:p"]);

    // An act whose event has no trace is still handed over, and records nothing on a trace that came later.
    h.state.online = false;
    await h.exec.execute(act(), "gone");
    await h.traces.record(trace("gone"));
    expect((await h.desk.deliver("sam")).map((a) => a.id)).toEqual(["gone:hand_back_done"]);
    expect((await h.traces.get("gone"))?.results).toBeUndefined();
  });
});
