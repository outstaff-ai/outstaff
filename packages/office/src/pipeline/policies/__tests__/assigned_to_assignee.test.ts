import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { ADA, SAM, OFFICE, judge, t, event, traceOf } from "./support.js";

describe("assigned_to_assignee", () => {
  it("an assignment to an agent by anyone but that agent", () => {
    const world = { tickets: { "ACME-1": t("ready", "sam") } };
    const assigned = (
      actor: PipelineEvent["actor"],
      type: PipelineEvent["type"] = "ticket.assigned",
    ) => event(type, { subject: { ticket: "ACME-1" }, actor });

    expect(judge("assigned_to_assignee", assigned(ADA), world)).toEqual([
      "wake sam (assigned) on ticket ACME-1",
    ]);

    expect(judge("assigned_to_assignee", assigned(ADA, "ticket.created"), world)).toEqual([
      "wake sam (assigned) on ticket ACME-1",
    ]);

    expect(judge("assigned_to_assignee", assigned({ kind: "agent", id: "noor" }), world)).toEqual([
      "wake sam (assigned) on ticket ACME-1",
    ]);

    // A ticket another agent filed for sam, from a chat session: created already assigned to sam.
    expect(
      judge(
        "assigned_to_assignee",
        assigned({ kind: "agent", id: "noor" }, "ticket.created"),
        world,
      ),
    ).toEqual(["wake sam (assigned) on ticket ACME-1"]);

    expect(judge("assigned_to_assignee", assigned(SAM), world)).toEqual({
      failed: { not: { actor_is: "assignee" } },
    });

    expect(judge("assigned_to_assignee", assigned(OFFICE), world)).toEqual({
      failed: { not: { actor_kind: "automation" } },
    });

    expect(
      judge("assigned_to_assignee", assigned(ADA), { tickets: { "ACME-1": t("done", "sam") } }),
    ).toMatchObject({
      failed: { not: {} },
    });
  });

  it("wakes no one on a ticket that is blocked while a ticket that blocks it is open, and says why", () => {
    const waiting = { tickets: { "ACME-1": t("blocked", "sam", { openBlockers: ["ACME-2"] }) } };
    const pia = { kind: "agent" as const, id: "noor" };
    for (const type of ["ticket.created", "ticket.assigned"] as const) {
      for (const actor of [ADA, pia]) {
        const e = event(type, { subject: { ticket: "ACME-1" }, actor });
        expect(judge("assigned_to_assignee", e, waiting)).toEqual({
          failed: {
            any: [{ not: { ticket_status: ["blocked"] } }, { open_blockers: false }],
          },
        });

        const trace = traceOf(e, waiting).policies.find((p) => p.policy === "assigned_to_assignee");
        expect(trace?.reason).toContain("ACME-2 still blocks the ticket");
      }
    }
  });

  it("still wakes the assignee of a blocked ticket nothing open blocks: the PM giving an unblocked ticket back", () => {
    const pm = { kind: "agent" as const, id: "noor" };
    for (const openBlockers of [[], undefined]) {
      const world = {
        tickets: {
          "ACME-1": t("blocked", "sam", openBlockers ? { openBlockers } : {}),
        },
      };

      expect(
        judge(
          "assigned_to_assignee",
          event("ticket.assigned", { subject: { ticket: "ACME-1" }, actor: pm }),
          world,
        ),
      ).toEqual(["wake sam (assigned) on ticket ACME-1"]);
    }
  });

  it("wakes the assignee of a ready ticket whose blockers are all closed", () => {
    const world = { tickets: { "ACME-1": t("ready", "sam", { openBlockers: [] }) } };
    expect(
      judge(
        "assigned_to_assignee",
        event("ticket.created", { subject: { ticket: "ACME-1" }, actor: ADA }),
        world,
      ),
    ).toEqual(["wake sam (assigned) on ticket ACME-1"]);
  });
});
