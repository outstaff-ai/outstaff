import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { event, judge, SAM, t } from "./support.js";

const back = (status: string, actor = SAM) =>
  event("agent.handed_back", {
    subject: { ticket: "ACME-1" },
    actor,
    data: { status, kind: "assigned" },
  });

const world = (
  status: StaticTicket["status"],
  roles: Record<string, string> = {},
  assignee = "sam",
) => ({
  tickets: { "ACME-1": t(status, assignee, { requester: "ada.admin" }) },
  roles,
});

describe("hand_back_blocked", () => {
  it("moves the ticket to blocked and gives it to the requester, also after a hand-back as done on a blocked ticket", () => {
    expect(judge("hand_back_blocked", back("blocked"), world("active"))).toEqual([
      "act for sam: move ACME-1 to blocked, assign ACME-1 to human ada.admin",
    ]);

    expect(judge("hand_back_blocked", back("done"), world("blocked"))).toEqual([
      "act for sam: assign ACME-1 to human ada.admin",
    ]);

    expect(judge("hand_back_blocked", back("waiting"), world("active"))).toMatchObject({
      failed: { any: expect.any(Array) },
    });
  });

  it("leaves the ticket to the team's PM, unless the PM is the blocked agent", () => {
    expect(judge("hand_back_blocked", back("blocked"), world("active", { pm: "priya" }))).toEqual([
      "drop: the team's PM, priya, unblocks it: hand_back_blocked_to_pm gives it to them",
    ]);

    const priya = { kind: "agent" as const, id: "priya" };
    expect(
      judge("hand_back_blocked", back("blocked", priya), world("active", { pm: "priya" }, "priya")),
    ).toEqual(["act for priya: move ACME-1 to blocked, assign ACME-1 to human ada.admin"]);
  });

  it("never undoes a hand-over: a ticket the agent gave to someone else during the work stays with them", () => {
    expect(judge("hand_back_blocked", back("blocked"), world("active", {}, "noor"))).toEqual([
      "drop: sam handed ACME-1 over to agent noor during the work, and a hand-back does not undo a hand-over",
    ]);

    expect(judge("hand_back_blocked", back("blocked"), world("active", {}, "ada.admin"))).toEqual([
      "act for sam: move ACME-1 to blocked",
    ]);
  });
});
