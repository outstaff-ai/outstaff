import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { ADA, SAM, OFFICE, judge, t, event } from "./support.js";

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
});
