import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { event, judge, SAM, t, traceOf } from "./support.js";

const back = (status: string, actor = SAM) =>
  event("agent.handed_back", {
    subject: { ticket: "ACME-1" },
    actor,
    data: { status, kind: "assigned", summary: "Stopped: the staging credentials are missing." },
  });

const world = (
  status: StaticTicket["status"],
  assignee = "sam",
  roles: Record<string, string> = { pm: "priya" },
) => ({
  tickets: { "ACME-1": t(status, assignee, { requester: "ada.admin" }) },
  roles,
});

describe("hand_back_blocked_to_pm", () => {
  it("moves the ticket to blocked and gives it to the PM, for the agent, then wakes the PM to unblock it", () => {
    expect(judge("hand_back_blocked_to_pm", back("blocked"), world("active"))).toEqual([
      "act for sam: move ACME-1 to blocked, assign ACME-1 to agent priya",
      "wake priya (unblock) on ticket ACME-1",
    ]);

    expect(judge("hand_back_blocked_to_pm", back("done"), world("blocked"))).toEqual([
      "act for sam: assign ACME-1 to agent priya",
      "wake priya (unblock) on ticket ACME-1",
    ]);
  });

  it("posts its note in the agent's voice and tells the PM who is blocked, on what, and whom to ask", () => {
    const decisions = traceOf(back("blocked"), world("active")).decisions.filter(
      (d) => d.policy === "hand_back_blocked_to_pm",
    );

    expect(decisions).toMatchObject([
      {
        type: "act",
        note: "Moved to blocked and assigned to the team's PM to unblock: I handed the work back as blocked.",
      },
      {
        type: "wake",
        person: "priya",
        instruction: expect.stringContaining(
          "sam handed ACME-1 back as blocked, and it is assigned to you to unblock.",
        ),
        feedback: [
          {
            actor: "sam",
            kind: "blocked",
            body: "Stopped: the staging credentials are missing.",
          },
        ],
      },
    ]);

    const wake = decisions[1] as { instruction: string };
    expect(wake.instruction).toContain("assign it back to sam");
    expect(wake.instruction).toContain("assign it to the requester, ada.admin, with a comment");
  });

  it("still wakes the PM when the ticket is already blocked and with them", () => {
    expect(judge("hand_back_blocked_to_pm", back("blocked"), world("blocked", "priya"))).toEqual([
      "drop: nothing to change: move: ACME-1 is already blocked; assign: ACME-1 is already assigned to priya",
      "wake priya (unblock) on ticket ACME-1",
    ]);
  });

  it("never undoes a hand-over to someone other than the PM: no move, no assignment and no unblock wake", () => {
    expect(judge("hand_back_blocked_to_pm", back("blocked"), world("active", "noor"))).toEqual([
      "drop: sam handed ACME-1 over to agent noor during the work, and a hand-back does not undo a hand-over",
    ]);
  });

  it("leaves the ticket to hand_back_blocked when the team has no PM or the PM is the blocked agent", () => {
    expect(judge("hand_back_blocked_to_pm", back("blocked"), world("active", "sam", {}))).toEqual([
      "drop: no PM to unblock it (no agent plays role:pm): hand_back_blocked gives it to the requester",
    ]);

    const priya = { kind: "agent" as const, id: "priya" };
    expect(
      judge("hand_back_blocked_to_pm", back("blocked", priya), world("active", "priya")),
    ).toEqual([
      "drop: no PM to unblock it (the blocked agent, priya, is the team's PM): hand_back_blocked gives it to the requester",
    ]);
  });

  it("does not listen to a hand-back that is neither blocked nor done on a blocked ticket", () => {
    expect(judge("hand_back_blocked_to_pm", back("waiting"), world("active"))).toMatchObject({
      failed: { any: expect.any(Array) },
    });
  });
});
