import { describe, expect, it } from "vitest";
import { definePolicy } from "#/define.js";
import { describeProposal, formatReplay, harnessEvent, replayPolicy } from "#/harness.js";
import { OPTS } from "./support.js";

const freeze = definePolicy({
  id: "freeze",
  summary: "test",
  on: ["ticket.assigned"],
  when: { assignee_kind: "agent" },
  instruction: "{{ticket}} waits.",
  decide: (_e, ctx) => [
    ...ctx.wake({ person: "assignee", kind: "assigned" }),
    { type: "suppress", person: "sam", kind: "chat", reason: "frozen" },
  ],
});

describe("replayPolicy", () => {
  it("replays recorded events through the policy as the bus runs it, and formats them for a snapshot", () => {
    const assigned = harnessEvent("ticket.assigned", { subject: { ticket: "ACME-1" } });
    const results = replayPolicy(
      freeze,
      [
        {
          event: assigned,
          world: {
            tickets: { "ACME-1": { status: "ready", assignee: { id: "sam", kind: "agent" } } },
          },
        },
        { event: assigned },
        { event: harnessEvent("pr.merged") },
      ],
      OPTS,
    );

    expect(formatReplay(results)).toBe(
      [
        "ticket.assigned test:ticket.assigned: matched (assignee is agent, wanted agent)",
        "  wake sam (assigned): ACME-1 waits.",
        "  suppress waking sam (chat): frozen",
        "ticket.assigned test:ticket.assigned: no (assignee is none, wanted agent)",
        "pr.merged test:pr.merged: no (listens to ticket.assigned, not pr.merged)",
      ].join("\n"),
    );
  });
});

describe("describeProposal", () => {
  it("puts every kind of proposal in words", () => {
    expect(
      describeProposal({
        type: "wake",
        person: "sam",
        kind: "assigned",
        instruction: "Go.",
        subject: { type: "ticket", ref: "ACME-1" },
        reason: "r",
      }),
    ).toBe("wake sam (assigned) on ticket ACME-1: Go.");

    const move = { op: "move" as const, ticket: "ACME-1", to: "review" as const };
    expect(describeProposal({ type: "act", as: "sam", ops: [move], reason: "r" })).toBe(
      "act for sam: move ACME-1",
    );

    expect(describeProposal({ type: "act", as: "sam", ops: [move], note: "n", reason: "r" })).toBe(
      "act for sam: move ACME-1 (note: n)",
    );

    expect(describeProposal({ type: "suppress", person: "sam", reason: "frozen" })).toBe(
      "suppress waking sam: frozen",
    );

    expect(describeProposal({ type: "drop", reason: "no" })).toBe("drop: no");
    expect(describeProposal({ type: "error", reason: "threw: boom" })).toBe("error: threw: boom");
  });
});
