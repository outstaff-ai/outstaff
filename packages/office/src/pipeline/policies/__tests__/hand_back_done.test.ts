import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { event, judge, pr, prRef, SAM, t } from "./support.js";

const back = (status: string) =>
  event("agent.handed_back", {
    subject: { ticket: "ACME-1" },
    actor: SAM,
    data: { status, kind: "assigned" },
  });

const world = (status: StaticTicket["status"], assignee: string | undefined = "sam") => ({
  tickets: { "ACME-1": t(status, assignee, { requester: "ada.admin" }) },
});

describe("hand_back_done", () => {
  it("moves the ticket to review and gives it to the requester, unless the agent moved it to blocked", () => {
    expect(judge("hand_back_done", back("done"), world("active"))).toEqual([
      "act for sam: move ACME-1 to review, assign ACME-1 to human ada.admin",
    ]);

    expect(judge("hand_back_done", back("done"), world("blocked"))).toMatchObject({
      failed: { not: {} },
    });
  });

  it("never undoes a hand-over: a ticket the agent gave to someone else during the work stays with them", () => {
    expect(judge("hand_back_done", back("done"), world("ready", "noor"))).toEqual([
      "drop: sam handed ACME-1 over to agent noor during the work, and a hand-back does not undo a hand-over",
    ]);

    expect(judge("hand_back_done", back("done"), world("active", "grace.lead"))).toEqual([
      "drop: sam handed ACME-1 over to human grace.lead during the work, and a hand-back does not undo a hand-over",
    ]);
  });

  it("still moves a ticket that is unassigned, or already with the requester", () => {
    expect(judge("hand_back_done", back("done"), world("active", undefined))).toEqual([
      "act for sam: move ACME-1 to review, assign ACME-1 to human ada.admin",
    ]);

    expect(judge("hand_back_done", back("done"), world("active", "ada.admin"))).toEqual([
      "act for sam: move ACME-1 to review",
    ]);
  });

  it("goes by the team's fallback human when the ticket has no requester, and needs a ticket", () => {
    expect(
      judge("hand_back_done", back("done"), { tickets: { "ACME-1": t("active", "ada.admin") } }),
    ).toEqual(["act for sam: move ACME-1 to review"]);

    const onPr = event("agent.handed_back", {
      subject: { pr: prRef(9) },
      actor: SAM,
      data: { status: "done", kind: "review_feedback" },
    });

    expect(judge("hand_back_done", onPr, { prs: [pr(9)] })).toEqual([
      "drop: nothing to change: move: the event has no linked ticket; assign: the event has no linked ticket",
    ]);
  });
});
