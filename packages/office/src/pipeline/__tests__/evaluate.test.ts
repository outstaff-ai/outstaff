import type { ConfiguredPolicy } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { evaluatePipeline } from "#/pipeline/evaluate.js";
import { event, OPTS, stateOf } from "./support.js";

const wakeAssignee: ConfiguredPolicy = {
  id: "wake_assignee",
  summary: "test",
  on: ["ticket.assigned"],
  when: { assignee_kind: "agent" },
  instruction: "Do {{ticket}}.",
  decide: (_e, ctx) => ctx.wake({ person: "assignee", kind: "assigned" }),
};

const always: ConfiguredPolicy = {
  id: "always",
  summary: "test",
  on: ["ticket.assigned"],
  decide: () => [{ type: "drop", reason: "seen" }],
};

const off: ConfiguredPolicy = { ...always, id: "off", enabled: false };
const world = {
  tickets: {
    "ACME-1": { status: "ready" as const, assignee: { id: "sam", kind: "agent" as const } },
  },
};

describe("evaluatePipeline", () => {
  it("hands the event to every policy, records what each proposed, and aggregates the proposals into the decisions", () => {
    const e = event("ticket.assigned", { subject: { ticket: "ACME-1" } });
    const trace = evaluatePipeline(e, stateOf(world), [off, wakeAssignee, always], OPTS);
    expect(trace.event).toBe(e);
    expect(trace.policies.map((p) => [p.policy, p.matched, p.reason])).toEqual([
      ["off", false, "turned off"],
      ["wake_assignee", true, "assignee is agent, wanted agent"],
      ["always", true, "no condition"],
    ]);

    expect(trace.policies[1]!.proposals).toEqual([
      {
        type: "wake",
        person: "sam",
        kind: "assigned",
        instruction: "Do ACME-1.",
        reason: "assignee is agent, wanted agent",
      },
    ]);

    expect(trace.aggregation).toEqual([
      { policy: "wake_assignee", proposal: 0, outcome: "kept", decision: 0 },
      { policy: "always", proposal: 0, outcome: "kept", decision: 1 },
    ]);

    expect(trace.decisions).toEqual([
      {
        type: "wake",
        policy: "wake_assignee",
        person: "sam",
        kind: "assigned",
        instruction: "Do ACME-1.",
        feedback: [],
        subject: { type: "ticket", ref: "ACME-1" },
        coalesceMs: 60_000,
      },
      { type: "drop", policy: "always", reason: "seen" },
    ]);
  });

  it("records the failing condition of a policy that listens but does not match", () => {
    const e = event("ticket.assigned", { subject: { ticket: "ACME-2" } });
    const trace = evaluatePipeline(e, stateOf(), [wakeAssignee], OPTS);
    expect(trace.policies).toEqual([
      {
        policy: "wake_assignee",
        matched: false,
        reason: "assignee is none, wanted agent",
        failed: { assignee_kind: "agent" },
        proposals: [],
      },
    ]);

    expect(trace.decisions).toEqual([{ type: "drop", reason: "no policy matched" }]);
  });

  it("says which event types a policy listens to", () => {
    const trace = evaluatePipeline(event("ticket.moved"), stateOf(), [wakeAssignee], OPTS);
    expect(trace.policies[0]!.reason).toBe("listens to ticket.assigned, not ticket.moved");
  });

  it("judges nothing from someone untrusted, nor a review comment still pending", () => {
    const untrusted = event("ticket.assigned", { data: { untrusted: true } });
    expect(evaluatePipeline(untrusted, stateOf(), [always], OPTS)).toEqual({
      event: untrusted,
      policies: [],
      aggregation: [],
      decisions: [
        {
          type: "drop",
          reason: "the event comes from someone who is not trusted: recorded, never acted on",
        },
      ],
    });

    const pending = event("pr.comment", { data: { kind: "review_comment", reviewId: 3 } });
    expect(evaluatePipeline(pending, stateOf(), [always], OPTS).decisions).toEqual([
      {
        type: "drop",
        reason: "an inline comment of a review still pending: the submitted review brings it",
      },
    ]);
  });

  it("contains a policy that throws: the others still decide, and the trace says so", () => {
    const throws: ConfiguredPolicy = {
      ...always,
      id: "throws",
      decide: () => {
        throw new Error("boom");
      },
    };

    const e = event("ticket.assigned", { subject: { ticket: "ACME-1" } });
    const trace = evaluatePipeline(e, stateOf(world), [throws, wakeAssignee], OPTS);
    expect(trace.policies[0]!.proposals).toEqual([{ type: "error", reason: "threw: boom" }]);
    expect(trace.aggregation[0]).toEqual({
      policy: "throws",
      proposal: 0,
      outcome: "error",
      reason: "threw: boom",
    });

    expect(trace.decisions.map((d) => d.type)).toEqual(["wake"]);
    expect(evaluatePipeline(e, stateOf(world), [throws], OPTS).decisions).toEqual([
      { type: "drop", reason: "no policy proposed anything" },
    ]);
  });
});
