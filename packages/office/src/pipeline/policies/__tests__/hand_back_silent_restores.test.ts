import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { event, judge, SAM, t } from "./support.js";

const ADA_TARGET = { kind: "human", id: "ada.admin" };

const silent = (before: Record<string, unknown> | undefined, status = "silent") =>
  event("agent.handed_back", {
    subject: { ticket: "ACME-1" },
    actor: SAM,
    data: { status, kind: "ticket_comment", ...(before ? { before } : {}) },
  });

const world = (status: StaticTicket["status"], assignee: string | undefined = "sam") => ({
  tickets: { "ACME-1": t(status, assignee, { requester: "ada.admin" }) },
});

describe("hand_back_silent_restores", () => {
  it("puts a ticket the round's start took back to its status and assignee, for the agent", () => {
    expect(
      judge(
        "hand_back_silent_restores",
        silent({ status: "review", assignee: ADA_TARGET }),
        world("active"),
      ),
    ).toEqual(["act for sam: move ACME-1 to review, assign ACME-1 to human ada.admin"]);
  });

  it("unassigns a ticket that had nobody, and leaves a status that was already active", () => {
    expect(
      judge("hand_back_silent_restores", silent({ status: "active" }), world("active")),
    ).toEqual(["act for sam: unassign ACME-1"]);
  });

  it("leaves alone what someone changed during the round, and drops when nothing is left", () => {
    expect(
      judge(
        "hand_back_silent_restores",
        silent({ status: "review", assignee: ADA_TARGET }),
        world("blocked", "grace.lead"),
      ),
    ).toEqual(["drop: nothing the round's start changed on ACME-1 is left to restore"]);

    expect(
      judge(
        "hand_back_silent_restores",
        silent({ status: "review", assignee: ADA_TARGET }),
        world("active", "grace.lead"),
      ),
    ).toEqual(["act for sam: move ACME-1 to review"]);
  });

  it("leaves a parent kept active for its open sub-tickets as it is", () => {
    expect(
      judge(
        "hand_back_silent_restores",
        silent({ status: "active", assignee: { kind: "agent", id: "sam" } }),
        world("active"),
      ),
    ).toEqual(["drop: nothing the round's start changed on ACME-1 is left to restore"]);
  });

  it("does nothing without a record of the round's start, nor for another status", () => {
    expect(judge("hand_back_silent_restores", silent(undefined), world("active"))).toEqual([
      "drop: the round's start recorded no ticket to restore",
    ]);

    expect(
      judge("hand_back_silent_restores", silent({ status: "review" }, "done"), world("active")),
    ).toMatchObject({ failed: {} });
  });
});
