import type { WorkflowEvent } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { toPipelineEvent } from "#/pipeline/from-workflow.js";

const NOW = "2026-10-05T12:00:00.000Z";
const assigned: WorkflowEvent = {
  type: "ticket.assigned",
  subject: { ticket: "ACME-1" },
  actor: { kind: "human", id: "ada.admin" },
  data: {},
};

describe("toPipelineEvent", () => {
  it("keys an office event by its source and external id, at the time the source gave", () => {
    const at = "2026-10-05T09:00:00.000Z";
    expect(
      toPipelineEvent({ ...assigned, data: { at } }, { source: "tracker", externalId: "e-1" }, NOW),
    ).toEqual({
      id: "tracker:e-1",
      type: "ticket.assigned",
      at,
      subject: { ticket: "ACME-1" },
      actor: { kind: "human", id: "ada.admin" },
      data: { at },
    });
  });

  it("uses now when the source gave no time, and skips types the pipeline does not decide on", () => {
    expect(toPipelineEvent(assigned, { source: "tracker", externalId: "e-1" }, NOW)?.at).toBe(NOW);
    expect(
      toPipelineEvent({ ...assigned, data: { at: "" } }, { source: "t", externalId: "e" }, NOW)?.at,
    ).toBe(NOW);

    expect(
      toPipelineEvent(
        { ...assigned, type: "schedule.cron" },
        { source: "t", externalId: "e" },
        NOW,
      ),
    ).toBeUndefined();
  });
});
