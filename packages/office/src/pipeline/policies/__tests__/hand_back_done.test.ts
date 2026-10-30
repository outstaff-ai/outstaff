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

describe("hand_back_done", () => {
  it("moves the ticket to review and gives it to the requester, unless the agent moved it to blocked", () => {
    expect(judge("hand_back_done", back("done"), world("active"))).toEqual([
      "act for sam: move ACME-1 to review, assign ACME-1 to human ada.admin",
    ]);

    expect(judge("hand_back_done", back("done"), world("blocked"))).toMatchObject({
      failed: { not: {} },
    });
  });
});
