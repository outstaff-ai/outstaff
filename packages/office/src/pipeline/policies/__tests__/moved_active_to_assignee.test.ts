import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import {
  judge,
  t,
  moveData,
  event,
  OPTS,
  stateOf,
  evaluatePipeline,
  BUILT_IN_POLICIES,
} from "./support.js";

describe("moved_active_to_assignee", () => {
  it("a human moving an agent's ticket to active", () => {
    const moved = (to: string) =>
      event("ticket.moved", { subject: { ticket: "ACME-1" }, data: moveData(to) });

    const world = { tickets: { "ACME-1": t("active", "sam") } };
    expect(judge("moved_active_to_assignee", moved("active"), world)).toEqual([
      "wake sam (assigned) on ticket ACME-1",
    ]);

    expect(judge("moved_active_to_assignee", moved("review"), world)).toEqual({
      failed: { moved_to: ["active"] },
    });

    const reason = (e: PipelineEvent) =>
      evaluatePipeline(e, stateOf(world), BUILT_IN_POLICIES, OPTS).policies.find(
        (p) => p.policy === "moved_active_to_assignee",
      )?.reason;

    expect(reason(moved("review"))).toBe("moved to In Review (review) in [active]");
    // A status the team's map does not know reaches the pipeline as its name only.
    const unmapped = event("ticket.moved", {
      subject: { ticket: "ACME-1" },
      data: { fromName: "Up Next", toName: "Doing" },
    });

    expect(reason(unmapped)).toBe("moved to Doing (unmapped) in [active]");
  });
});
