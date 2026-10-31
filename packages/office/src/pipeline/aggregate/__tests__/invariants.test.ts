import { describe, expect, it } from "vitest";
import { aggregated, event, move, proposing, wake } from "./support.js";

describe("the invariants", () => {
  it("never wakes or acts for someone who is not an agent on the team: never as the office", () => {
    const trace = aggregated([
      proposing("p", [
        wake("office"),
        { type: "act", as: "office", ops: [move("review")], reason: "r" },
      ]),
    ]);

    expect(trace.aggregation).toEqual([
      {
        policy: "p",
        proposal: 0,
        outcome: "rejected",
        reason: "office is not an agent on the team",
        decision: 0,
      },
      {
        policy: "p",
        proposal: 1,
        outcome: "rejected",
        reason: "never act as the office: office is not an agent on the team",
        decision: 1,
      },
    ]);

    expect(trace.decisions).toEqual([
      { type: "drop", policy: "p", reason: "office is not an agent on the team" },
      {
        type: "drop",
        policy: "p",
        reason: "never act as the office: office is not an agent on the team",
      },
    ]);
  });

  it("suppresses only the wakes of agents on the team", () => {
    const trace = aggregated([
      proposing("p", [{ type: "suppress", person: "office", reason: "r" }, wake("sam")]),
    ]);

    expect(trace.aggregation[0]).toEqual({
      policy: "p",
      proposal: 0,
      outcome: "rejected",
      reason: "office is not an agent on the team",
    });

    expect(trace.decisions).toMatchObject([{ type: "wake", person: "sam" }]);
  });

  it("never wakes an agent for its own action, except the office's idle pull for it", () => {
    const sam = { kind: "agent" as const, id: "sam" };
    const own = aggregated(
      [proposing("p", [wake("sam")])],
      event("ticket.assigned", { subject: { ticket: "ACME-1" }, actor: sam }),
    );

    expect(own.decisions).toEqual([
      {
        type: "drop",
        policy: "p",
        reason: "never wake an agent for its own action: sam caused the event",
      },
    ]);

    const idle = aggregated(
      [proposing("p", [wake("sam", { subject: { type: "ticket", ref: "ACME-1" } })])],
      event("agent.idle", { actor: sam }),
    );

    expect(idle.decisions).toMatchObject([{ type: "wake", person: "sam", coalesceMs: 0 }]);
  });

  it("wakes no one for the tracker's echo of an office act, the assignment an act made included", () => {
    const sam = { kind: "agent" as const, id: "sam" };
    const echo = aggregated(
      [
        proposing("p", [
          wake("noor"),
          { type: "act", as: "sam", ops: [move("review")], reason: "r" },
        ]),
      ],
      event("ticket.assigned", {
        subject: { ticket: "ACME-1" },
        actor: sam,
        data: { echo: "workstate:handed_back:w1:1:hand_back_blocked_to_pm" },
      }),
    );

    expect(echo.aggregation[0]).toEqual({
      policy: "p",
      proposal: 0,
      outcome: "rejected",
      reason:
        "the echo of act workstate:handed_back:w1:1:hand_back_blocked_to_pm, which the office decided: the event that caused the act already decided whom to wake",
      decision: 0,
    });

    // Only the wakes: an act on the echo is judged as on any event.
    expect(echo.decisions[1]).toMatchObject({ type: "act", as: "sam" });

    // The same assignment made by the agent itself, not by an act, wakes the assignee.
    const own = aggregated(
      [proposing("p", [wake("noor")])],
      event("ticket.assigned", { subject: { ticket: "ACME-1" }, actor: sam }),
    );

    expect(own.decisions).toMatchObject([{ type: "wake", person: "noor" }]);
  });

  it("guards against loops: a bot's event wakes no one, the office's own events do", () => {
    const bot = { kind: "automation" as const, id: "renovate[bot]" };
    const byBot = aggregated(
      [proposing("p", [wake("sam")])],
      event("pr.comment", { subject: { ticket: "ACME-1" }, actor: bot }),
    );

    expect(byBot.decisions).toEqual([
      {
        type: "drop",
        policy: "p",
        reason: "loop guard: an event a bot (renovate[bot]) caused wakes no one",
      },
    ]);

    for (const id of ["office", "workstate"]) {
      const byOffice = aggregated(
        [proposing("p", [wake("sam")])],
        event("pr.comment", { subject: { ticket: "ACME-1" }, actor: { kind: "automation", id } }),
      );

      expect(byOffice.decisions).toMatchObject([{ type: "wake", person: "sam" }]);
    }
  });

  it("keeps acts to bookkeeping, and one act per policy and event", () => {
    const comment = { op: "comment", on: { ticket: "ACME-1" }, body: "Looks fine." };
    const trace = aggregated([
      proposing("judges", [
        { type: "act", as: "sam", ops: [move("review"), comment], reason: "r" } as never,
      ]),
      proposing("twice", [
        { type: "act", as: "sam", ops: [move("done", "ACME-2")], reason: "r" },
        { type: "act", as: "sam", ops: [move("done", "ACME-3")], reason: "r" },
      ]),
    ]);

    expect(trace.aggregation.map((a) => [a.policy, a.outcome, a.reason])).toEqual([
      [
        "judges",
        "rejected",
        "an act is bookkeeping only: comment is not one of move, assign, set_parent, link_pr; anything that needs judgement is a wake",
      ],
      ["twice", "kept", undefined],
      ["twice", "rejected", "one act per policy and event: return one act with every change"],
    ]);

    expect(trace.decisions[1]).toMatchObject({ type: "act", ops: [move("done", "ACME-2")] });
  });
});
