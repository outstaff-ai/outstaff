import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { event, judge, t, traceOf, type World } from "./support.js";

const M1 = { id: "7", title: "Foundations" };

/** ACME-21 closed, as the work state reports it. */
const closed = (status: "done" | "canceled" = "done", ticket = "ACME-21") =>
  event("ticket.closed", {
    subject: { ticket },
    actor: { kind: "automation", id: "workstate" },
    data: { status, closedBy: { kind: "human", id: "ada.admin" } },
  });

const inM1 = (status: StaticTicket["status"]) => t(status, "sam", { initiative: M1 });

const world = (more: Record<string, StaticTicket> = {}, roles = { pm: "priya" }): World => ({
  tickets: { "ACME-21": inM1("done"), ...more },
  roles,
});

describe("milestone_done_to_pm", () => {
  it("wakes the PM on the closed ticket when it was the last open ticket of its milestone", () => {
    const w = world({ "ACME-20": inM1("done"), "ACME-22": inM1("canceled") });
    expect(judge("milestone_done_to_pm", closed(), w)).toEqual([
      "wake priya (milestone) on ticket ACME-21",
    ]);

    expect(judge("milestone_done_to_pm", closed("canceled"), w)).toEqual([
      "wake priya (milestone) on ticket ACME-21",
    ]);

    const wake = traceOf(closed(), w).decisions.find((d) => d.policy === "milestone_done_to_pm");
    expect(wake).toMatchObject({
      type: "wake",
      person: "priya",
      kind: "milestone",
      instruction: expect.stringContaining(
        'ACME-21 was closed as done, and it was the last open ticket of milestone "Foundations" (7) that the office knows. Check with `ost milestone show 7`',
      ),
    });

    expect((wake as { instruction: string }).instruction).toContain(
      "close it (`ost milestone status 7 done`)",
    );
  });

  it("waits while another ticket of the milestone is open, one in the backlog too", () => {
    expect(judge("milestone_done_to_pm", closed(), world({ "ACME-22": inM1("review") }))).toEqual([
      "drop: milestone Foundations still has open tickets: ACME-22",
    ]);

    const later = world({ "ACME-22": inM1("backlog"), "ACME-23": inM1("active") });
    expect(judge("milestone_done_to_pm", closed(), later)).toEqual([
      "drop: milestone Foundations still has open tickets: ACME-22, ACME-23",
    ]);

    // A ticket of another milestone does not hold this one.
    const other = world({
      "ACME-30": t("active", "sam", { initiative: { id: "8", title: "Next" } }),
    });

    expect(judge("milestone_done_to_pm", closed(), other)).toEqual([
      "wake priya (milestone) on ticket ACME-21",
    ]);
  });

  it("wakes no one for a ticket in no milestone, a ticket still open, or a team without a PM", () => {
    const none = { tickets: { "ACME-21": t("done", "sam") }, roles: { pm: "priya" } };
    expect(judge("milestone_done_to_pm", closed(), none)).toEqual({
      failed: { in_milestone: true },
    });

    expect(judge("milestone_done_to_pm", closed(), world({ "ACME-21": inM1("review") }))).toEqual({
      failed: { ticket_status: ["done", "canceled"] },
    });

    expect(judge("milestone_done_to_pm", closed(), world({}, {} as { pm: string }))).toEqual([
      expect.stringMatching(/^drop: .*role:pm/),
    ]);
  });
});
