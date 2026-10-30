import type { StaticTicket } from "@outstaff/core";
import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import {
  ADA,
  SAM,
  judge,
  t,
  moveData,
  event,
  OPTS,
  stateOf,
  evaluatePipeline,
  BUILT_IN_POLICIES,
  type World,
} from "./support.js";

describe("moved_active_to_last_worker", () => {
  it("a human moving a ticket an agent handed back to active", () => {
    const handedBack = (
      assignee = "ada.admin",
      extra: Partial<StaticTicket> = { lastWorker: "sam" },
    ) => ({
      tickets: { "ACME-1": t("active", assignee, extra) },
    });

    const moved = (to = "active", actor = ADA) =>
      event("ticket.moved", { subject: { ticket: "ACME-1" }, actor, data: moveData(to) });

    const judged = (e: PipelineEvent, world: World) =>
      judge("moved_active_to_last_worker", e, world);

    expect(judged(moved(), handedBack())).toEqual([
      "act for sam: assign ACME-1 to agent sam",
      "wake sam (assigned) on ticket ACME-1",
    ]);

    const trace = evaluatePipeline(moved(), stateOf(handedBack()), BUILT_IN_POLICIES, OPTS);
    expect(trace.decisions).toMatchObject([
      { type: "act", policy: "moved_active_to_last_worker", as: "sam" },
      {
        type: "wake",
        policy: "moved_active_to_last_worker",
        instruction:
          "ada-admin moved ACME-1 to active and it is assigned to you again. Pick the work up.",
      },
    ]);

    expect(trace.decisions[0]).not.toHaveProperty("note");
    expect(judged(moved("active", SAM), handedBack())).toEqual({
      failed: { actor_kind: "human" },
    });

    expect(judged(moved("review"), handedBack())).toEqual({ failed: { moved_to: ["active"] } });
    expect(judged(moved(), handedBack("sam"))).toEqual({ failed: { assignee_kind: "human" } });
    expect(
      judged(moved(), handedBack("ada.admin", { lastWorker: "sam", labels: ["needs-human"] })),
    ).toEqual({ failed: { not: { has_label: "$needs_human" } } });

    expect(judged(moved(), handedBack("ada.admin", {}))).toEqual([
      "drop: no agent to act for: no agent has worked on the ticket yet",
    ]);
  });
});
