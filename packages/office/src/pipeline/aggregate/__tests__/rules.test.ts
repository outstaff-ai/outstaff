import { describe, expect, it } from "vitest";
import { OPTS } from "#/pipeline/__tests__/support.js";
import { aggregated, event, move, ON_TICKET, proposing, wake } from "./support.js";

describe("suppression", () => {
  it("beats every wake it matches, whatever the priorities, narrowed by subject and kind", () => {
    const trace = aggregated([
      proposing(
        "waker",
        [
          wake("sam"),
          wake("noor"),
          wake("sam", { subject: { type: "ticket", ref: "ACME-2" } }),
          wake("sam", { kind: "chat", subject: { type: "ticket", ref: "ACME-3" } }),
        ],
        { priority: 10 },
      ),
      proposing("freeze", [
        {
          type: "suppress",
          person: "sam",
          subject: { type: "ticket", ref: "ACME-1" },
          reason: "frozen",
        },
        { type: "suppress", person: "sam", kind: "assigned", reason: "no assignments" },
        { type: "suppress", person: "mira", reason: "away" },
      ]),
    ]);

    expect(trace.aggregation).toEqual([
      {
        policy: "waker",
        proposal: 0,
        outcome: "suppressed",
        reason: "suppressed by freeze: frozen",
        decision: 0,
      },
      { policy: "waker", proposal: 1, outcome: "kept", decision: 1 },
      {
        policy: "waker",
        proposal: 2,
        outcome: "suppressed",
        reason: "suppressed by freeze: no assignments",
        decision: 2,
      },
      { policy: "waker", proposal: 3, outcome: "kept", decision: 3 },
      {
        policy: "freeze",
        proposal: 0,
        outcome: "kept",
        reason: "suppressed the wake of sam by waker",
      },
      {
        policy: "freeze",
        proposal: 1,
        outcome: "kept",
        reason: "suppressed the wake of sam by waker",
      },
      { policy: "freeze", proposal: 2, outcome: "kept", reason: "no wake of mira to suppress" },
    ]);

    expect(trace.decisions.map((d) => d.type)).toEqual(["drop", "wake", "drop", "wake"]);
  });
});

describe("conflicting acts", () => {
  const act = (ops: ReturnType<typeof move>[]) => ({
    type: "act" as const,
    as: "sam",
    ops,
    reason: "r",
  });

  it("settle on the same ticket field by priority, then by order; the same change is made once", () => {
    const trace = aggregated([
      proposing("low", [act([move("review"), move("done", "ACME-2")])]),
      proposing("high", [act([move("done")])], { priority: 5 }),
      proposing("same", [act([move("done")])], { priority: 5 }),
      proposing("other", [act([move("review", "ACME-3")])]),
    ]);

    expect(trace.aggregation.map((a) => [a.policy, a.outcome, a.reason])).toEqual([
      ["low", "kept", "move ACME-1 to review: conflicts with high, which takes priority"],
      ["high", "kept", undefined],
      ["same", "dropped", "move ACME-1 to done: already made by high"],
      ["other", "kept", undefined],
    ]);

    expect(trace.decisions).toEqual([
      { type: "act", policy: "low", as: "sam", ops: [move("done", "ACME-2")] },
      { type: "act", policy: "high", as: "sam", ops: [move("done")] },
      { type: "drop", policy: "same", reason: "move ACME-1 to done: already made by high" },
      { type: "act", policy: "other", as: "sam", ops: [move("review", "ACME-3")] },
    ]);
  });

  it("leave the proposals in the trace as the policies made them", () => {
    const proposals = [act([move("review"), move("done", "ACME-2")])];
    const before = structuredClone(proposals);
    const trace = aggregated([
      proposing("low", proposals),
      proposing("high", [act([move("done")])], { priority: 1 }),
    ]);

    expect(trace.policies[0]!.proposals).toEqual(before);
  });
});

describe("merging wakes", () => {
  it("makes wakes of one person, subject and kind one, with every distinct instruction", () => {
    const trace = aggregated(
      [
        proposing("first", [wake("sam")]),
        proposing("second", [wake("sam", { instruction: "Also this." }), wake("noor")]),
        proposing("third", [wake("sam")]),
        proposing("chat", [wake("sam", { kind: "chat" })]),
        proposing("chat_again", [wake("sam", { kind: "chat", instruction: "Answer." })]),
      ],
      ON_TICKET,
      { ...OPTS, coalesceMs: 5000 },
    );

    expect(trace.aggregation.map((a) => [a.policy, a.outcome, a.reason, a.decision])).toEqual([
      ["first", "kept", undefined, 0],
      ["second", "merged", "merged into the wake of sam by first", 0],
      ["second", "kept", undefined, 1],
      ["third", "merged", "merged into the wake of sam by first", 0],
      ["chat", "kept", undefined, 2],
      ["chat_again", "merged", "merged into the wake of sam by chat", 2],
    ]);

    expect(trace.decisions).toMatchObject([
      {
        type: "wake",
        policy: "first",
        person: "sam",
        kind: "assigned",
        instruction: "Go, sam.\n\nAlso this.",
        coalesceMs: 5000,
      },
      { type: "wake", person: "noor", coalesceMs: 5000 },
      {
        type: "wake",
        person: "sam",
        kind: "chat",
        instruction: "Go, sam.\n\nAnswer.",
        coalesceMs: 0,
      },
    ]);
  });

  it("drops a wake whose event has no subject, and gives a chat wake no window", () => {
    expect(aggregated([proposing("p", [wake("sam")])], event("ticket.assigned")).decisions).toEqual(
      [
        {
          type: "drop",
          policy: "p",
          reason: "the event has no ticket, pull request, document or chat thread",
        },
      ],
    );

    const chat = event("chat.message", { subject: { chat: { channel: "D0SAM", thread: "17.1" } } });
    expect(
      aggregated([proposing("p", [wake("sam", { kind: "chat" })])], chat).decisions,
    ).toMatchObject([
      { type: "wake", subject: { type: "chat", ref: "D0SAM:17.1" }, coalesceMs: 0 },
    ]);

    const doc = event("pr.comment", { subject: { doc: "doc-7" } });
    expect(aggregated([proposing("p", [wake("sam")])], doc).decisions).toMatchObject([
      { subject: { type: "doc", ref: "doc-7" }, coalesceMs: 60_000 },
    ]);
  });
});
