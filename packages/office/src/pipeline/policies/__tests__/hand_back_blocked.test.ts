import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { event, judge, SAM, t } from "./support.js";

const back = (status: string) =>
  event("agent.handed_back", {
    subject: { ticket: "ACME-1" },
    actor: SAM,
    data: { status, kind: "assigned" },
  });

const world = (status: StaticTicket["status"]) => ({
  tickets: { "ACME-1": t(status, "sam", { requester: "ada.admin" }) },
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
});
