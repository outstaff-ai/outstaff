import { describe, expect, it } from "vitest";
import { evaluatePipeline } from "#/pipeline/evaluate.js";
import type { Policy } from "#/pipeline/policy.types.js";
import { event, OPTS, stateOf } from "./support.js";

const wakeAssignee: Policy = {
  id: "wake_assignee",
  summary: "test",
  on: ["ticket.assigned"],
  when: { assignee_kind: "agent" },
  decide: { wake: { person: "assignee", kind: "assigned" } },
  instruction: "Do {{ticket}}.",
};

const always: Policy = {
  id: "always",
  summary: "test",
  on: ["ticket.assigned"],
  decide: { drop: { reason: "seen" } },
};

const off: Policy = { ...always, id: "off", enabled: false };
const world = {
  tickets: {
    "ACME-1": { status: "ready" as const, assignee: { id: "sam", kind: "agent" as const } },
  },
};

describe("evaluatePipeline", () => {
  it("evaluates every policy in order and collects the decisions of those that match", () => {
    const e = event("ticket.assigned", { subject: { ticket: "ACME-1" } });
    const trace = evaluatePipeline(e, stateOf(world), [off, wakeAssignee, always], OPTS);
    expect(trace.event).toBe(e);
    expect(trace.policies.map((p) => [p.policy, p.matched, p.reason])).toEqual([
      ["off", false, "turned off"],
      ["wake_assignee", true, "assignee is agent, wanted agent"],
      ["always", true, "no condition"],
    ]);

    expect(trace.decisions.map((d) => d.type)).toEqual(["wake", "drop"]);
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
        decisions: [],
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
});
