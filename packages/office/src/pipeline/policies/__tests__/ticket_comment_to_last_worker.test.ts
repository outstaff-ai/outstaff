import type { StaticTicket } from "@outstaff/core";
import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import {
  ADA,
  SAM,
  judge,
  t,
  event,
  OPTS,
  stateOf,
  evaluatePipeline,
  BUILT_IN_POLICIES,
  type World,
} from "./support.js";

describe("ticket_comment_to_last_worker", () => {
  it("a human's comment on a ticket an agent handed back", () => {
    const handedBack = (
      status: StaticTicket["status"] = "review",
      assignee = "ada.admin",
      lastWorker: string | undefined = "sam",
    ) => ({
      tickets: { "ACME-1": t(status, assignee, lastWorker ? { lastWorker } : {}) },
    });

    const comment = (data: Record<string, unknown> = {}, actor = ADA) =>
      event("ticket.commented", {
        subject: { ticket: "ACME-1" },
        actor,
        data: { body: "Why this way?", ...data },
      });

    const judged = (e: PipelineEvent, world: World) =>
      judge("ticket_comment_to_last_worker", e, world);

    expect(judged(comment(), handedBack())).toEqual(["wake sam (ticket_comment) on ticket ACME-1"]);
    expect(judged(comment(), handedBack("blocked"))).toEqual([
      "wake sam (ticket_comment) on ticket ACME-1",
    ]);

    const trace = evaluatePipeline(comment(), stateOf(handedBack()), BUILT_IN_POLICIES, OPTS);
    expect(trace.decisions).toMatchObject([
      {
        type: "wake",
        policy: "ticket_comment_to_last_worker",
        instruction:
          "ada-admin commented on ACME-1, which you handed back. Answer the comment on the ticket. If it needs more work, assign the ticket to yourself, move it to active and do the work.",
      },
    ]);

    // A blocked ticket an agent is blocked on is that agent's: ticket_comment_to_blocked_agent wakes it.
    expect(
      judged(comment(), {
        tickets: {
          "ACME-1": t("blocked", "ada.admin", { lastWorker: "sam", blockedAgent: "sam" }),
        },
      }),
    ).toEqual({ failed: { not: { blocked_agent: true } } });

    expect(judged(comment({}, SAM), handedBack())).toEqual({ failed: { actor_kind: "human" } });
    expect(judged(comment({ mentions: ["mira"] }), handedBack())).toEqual({
      failed: { not: { agent_mentioned: true } },
    });

    expect(judged(comment(), handedBack("review", "sam"))).toEqual({
      failed: { assignee_kind: "human" },
    });

    for (const status of ["done", "canceled", "active"] as const) {
      expect(judged(comment(), handedBack(status))).toEqual({
        failed: { ticket_status: ["review", "blocked"] },
      });
    }

    expect(judged(comment(), handedBack("review", "ada.admin", ""))).toEqual([
      "drop: no one to wake: no agent has worked on the ticket yet",
    ]);

    expect(judged(comment(), handedBack("review", "ada.admin", "someone-else"))).toEqual([
      "drop: no one to wake: someone-else (last_worker) is not an agent on the team",
    ]);
  });
});
