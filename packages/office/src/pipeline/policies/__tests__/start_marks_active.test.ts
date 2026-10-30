import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { event, judge, prRef, prWorld, SAM, t } from "./support.js";

const started = (kind: string) =>
  event("agent.started", {
    subject: { ticket: "ACME-1" },
    actor: SAM,
    data: { workItem: "w-1", kind },
  });

const world = (status: StaticTicket["status"], assignee?: string) => ({
  tickets: { "ACME-1": t(status, assignee, { requester: "ada.admin" }) },
});

describe("start_marks_active", () => {
  it("assigns the ticket to the agent and moves it to active, with only the changes still needed", () => {
    expect(
      judge("start_marks_active", started("review_feedback"), world("review", "ada.admin")),
    ).toEqual(["act for sam: assign ACME-1 to agent sam, move ACME-1 to active"]);

    expect(judge("start_marks_active", started("assigned"), world("ready", "sam"))).toEqual([
      "act for sam: move ACME-1 to active",
    ]);

    expect(
      judge("start_marks_active", started("ticket_comment"), world("blocked", "ada.admin")),
    ).toEqual(["act for sam: assign ACME-1 to agent sam, move ACME-1 to active"]);

    expect(judge("start_marks_active", started("assigned"), world("active", "sam"))).toEqual([
      "drop: nothing to change: assign: ACME-1 is already assigned to sam; move: ACME-1 is already active",
    ]);
  });

  it("acts on the ticket of a pull request's round", () => {
    const onPr = event("agent.started", {
      subject: { pr: prRef(9), ticket: "ACME-9" },
      actor: SAM,
      data: { workItem: "w-2", kind: "ci_failed" },
    });

    expect(judge("start_marks_active", onPr, prWorld({}, "review"))).toEqual([
      "act for sam: move ACME-9 to active",
    ]);
  });

  it("leaves a finished ticket, and rounds that do not work on the ticket, alone", () => {
    for (const status of ["done", "canceled"] as const) {
      expect(judge("start_marks_active", started("rebase"), world(status, "sam"))).toMatchObject({
        failed: { not: {} },
      });
    }

    for (const kind of ["chat", "doc_feedback", "asked", "unblock", "merge"]) {
      expect(judge("start_marks_active", started(kind), world("review", "ada.admin"))).toEqual({
        failed: {
          work_kind: ["assigned", "review_feedback", "ticket_comment", "rebase", "ci_failed"],
        },
      });
    }
  });
});
