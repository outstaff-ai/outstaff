import { describe, expect, it } from "vitest";
import { createMemoryTraceStore } from "../../memory-traces.js";
import type { Trace } from "../../trace.types.js";
import type { Comparison } from "../compare.types.js";
import { describeDifference, describeOutcome, formatEngine, formatSummary } from "../describe.js";
import { compareRange, summarize } from "../summary.js";

const differ: Comparison = {
  agree: false,
  differences: [
    {
      kind: "missing_in_pipeline",
      engine: { type: "move", ticket: "ACME-1", to: "active", as: "office" },
    },
    {
      kind: "different",
      engine: { type: "wake", person: "sam", kind: "conflict" },
      pipeline: { type: "wake", person: "sam", kind: "rebase", policy: "rebase_to_author" },
      policy: "rebase_to_author",
    },
  ],
};

const agree: Comparison = {
  agree: true,
  differences: [
    {
      kind: "actor_changed",
      engine: { type: "move", ticket: "ACME-2", to: "review", as: "office" },
      pipeline: {
        type: "move",
        ticket: "ACME-2",
        to: "review",
        as: "sam",
        policy: "hand_back_done",
      },
      policy: "hand_back_done",
      note: "attributed to sam, not the office",
    },
  ],
};

const trace = (id: string, at: string, comparison?: Comparison): Trace => ({
  event: {
    id,
    type: "ticket.assigned",
    at,
    subject: {},
    actor: { kind: "human", id: "ada.admin" },
    data: {},
  },
  policies: [],
  decisions: [],
  ...(comparison ? { engine: { effects: [] }, comparison } : {}),
});

describe("summarize", () => {
  it("counts the events, those compared, agreeing and differing, by kind and by policy", () => {
    const s = summarize(
      [
        trace("a", "2026-10-05T09:00:00.000Z", differ),
        trace("b", "2026-10-05T09:01:00.000Z", agree),
        trace("c", "2026-10-05T09:02:00.000Z"),
      ],
      { since: "2026-10-05T00:00:00.000Z", until: "2026-10-06T00:00:00.000Z" },
    );

    expect(s).toEqual({
      since: "2026-10-05T00:00:00.000Z",
      until: "2026-10-06T00:00:00.000Z",
      events: 3,
      compared: 2,
      agree: 1,
      differ: 1,
      byKind: { missing_in_pipeline: 1, different: 1, actor_changed: 1 },
      byPolicy: { "(none)": 1, rebase_to_author: 1, hand_back_done: 1 },
      differing: [
        {
          id: "a",
          type: "ticket.assigned",
          at: "2026-10-05T09:00:00.000Z",
          differences: differ.differences,
        },
      ],
    });

    expect(formatSummary(s)).toBe(
      [
        "Events (2026-10-05T00:00:00.000Z to 2026-10-06T00:00:00.000Z): 3; compared: 2; agree: 1; differ: 1",
        "",
        "Differences by kind:",
        "  actor_changed: 1",
        "  different: 1",
        "  missing_in_pipeline: 1",
        "",
        "Differences by policy:",
        "  (none): 1",
        "  hand_back_done: 1",
        "  rebase_to_author: 1",
        "",
        "Events that differ:",
        "  2026-10-05T09:00:00.000Z  ticket.assigned  a",
        "    missing_in_pipeline: engine: move ACME-1 to active (by the office)",
        "    different [rebase_to_author]: engine: wake sam (conflict); pipeline: wake sam (rebase)",
      ].join("\n"),
    );

    expect(formatSummary(summarize([]))).toBe("Events: 0; compared: 0; agree: 0; differ: 0");
    expect(formatSummary(summarize([trace("b", "x", agree)], { since: "s" }))).toContain(
      "(s to now)",
    );

    expect(formatSummary(summarize([], { until: "u" }))).toContain("(start to u)");
  });
});

describe("compareRange", () => {
  it("reads every event in the range, page by page, events of one time included whole", async () => {
    const traces = createMemoryTraceStore();
    for (let i = 0; i < 450; i++) {
      // Three events share each time, so pages end in the middle of a time.
      const at = new Date(Date.UTC(2026, 9, 5, 9, 0, Math.floor(i / 3))).toISOString();
      await traces.record(trace(`e:${i}`, at, i % 2 ? agree : differ));
    }

    await traces.record(trace("same:1", "2026-10-04T00:00:00.000Z"));
    const all = await compareRange(traces);
    expect([all.events, all.compared, all.agree, all.differ]).toEqual([451, 450, 225, 225]);
    const since = await compareRange(traces, { since: "2026-10-05T09:02:00.000Z" });
    expect(since.events).toBe(450 - 120 * 3);
    const until = await compareRange(traces, { until: "2026-10-05T09:00:01.000Z" });
    expect(until.events).toBe(4);
  });

  it("does not loop on a page whose events all share one time", async () => {
    const traces = createMemoryTraceStore();
    for (let i = 0; i < 250; i++) {
      await traces.record(trace(`t:${i}`, "2026-10-05T09:00:00.000Z"));
    }

    expect((await compareRange(traces)).events).toBe(200);
  });
});

describe("describing outcomes", () => {
  it("says what each outcome, difference and engine record is", () => {
    expect(
      describeOutcome({
        type: "wake",
        person: "sam",
        kind: "assigned",
        subject: { type: "ticket", ref: "ACME-1" },
      }),
    ).toBe("wake sam (assigned) on ticket ACME-1");

    expect(
      describeOutcome({
        type: "assign",
        ticket: "ACME-1",
        to: { kind: "human", id: "ada.admin" },
        as: "sam",
      }),
    ).toBe("assign ACME-1 to human ada.admin (for sam)");

    expect(describeOutcome({ type: "assign", ticket: "ACME-1", to: null, as: "office" })).toBe(
      "assign ACME-1 to nobody (by the office)",
    );

    expect(describeOutcome({ type: "comment", on: "ACME-1", as: "office" })).toBe(
      "comment on ACME-1 (by the office)",
    );

    expect(
      describeOutcome({ type: "set_parent", ticket: "ACME-2", parent: "ACME-1", as: "sam" }),
    ).toBe("set the parent of ACME-2 to ACME-1 (for sam)");

    expect(describeDifference(agree.differences[0]!)).toBe(
      "actor_changed [hand_back_done]: engine: move ACME-2 to review (by the office); pipeline: move ACME-2 to review (for sam) (attributed to sam, not the office)",
    );

    const move = { type: "move" as const, ticket: "ACME-1", to: "review", as: "office" };
    expect(
      formatEngine(
        {
          effects: [],
          skipped: [{ outcome: move, note: "no tracker" }],
          failed: [{ outcome: move, note: "forbidden" }],
        },
        undefined,
      ),
    ).toEqual([
      "Engine (today):",
      "  nothing",
      "  skipped: move ACME-1 to review (by the office): no tracker",
      "  failed: move ACME-1 to review (by the office): forbidden",
    ]);

    expect(formatEngine({ effects: [move] }, agree)).toEqual([
      "Engine (today):",
      "  move ACME-1 to review (by the office)",
      "",
      "Comparison: agree",
      `  ${describeDifference(agree.differences[0]!)}`,
    ]);

    expect(describeDifference({ kind: "extra_in_pipeline", pipeline: move })).toBe(
      "extra_in_pipeline: pipeline: move ACME-1 to review (by the office)",
    );

    expect(formatEngine({ effects: [move] }, differ).slice(0, 4)).toEqual([
      "Engine (today):",
      "  move ACME-1 to review (by the office)",
      "",
      "Comparison: differ",
    ]);
  });
});
