import { describe, expect, it } from "vitest";
import { ADA, SAM, judge, t, event } from "./support.js";

describe("ticket_comment_to_agent", () => {
  it("a human's comment that mentions no agent wakes the assignee", () => {
    const world = { tickets: { "ACME-1": t("active", "sam") } };
    const comment = (data: Record<string, unknown> = {}, actor = ADA) =>
      event("ticket.commented", {
        subject: { ticket: "ACME-1" },
        actor,
        data: { body: "x", ...data },
      });

    expect(judge("ticket_comment_to_agent", comment(), world)).toEqual([
      "wake sam (ticket_comment) on ticket ACME-1",
    ]);

    // A mention is ticket_comment_to_mentioned_agent's, even of the assignee.
    for (const mentioned of ["mira", "sam"]) {
      expect(
        judge("ticket_comment_to_agent", comment({ mentions: [mentioned] }), world),
      ).toMatchObject({ failed: { not: { agent_mentioned: true } } });
    }

    expect(
      judge("ticket_comment_to_agent", comment(), {
        tickets: { "ACME-1": t("review", "ada.admin") },
      }),
    ).toEqual({ failed: { assignee_kind: "agent" } });

    expect(judge("ticket_comment_to_agent", comment({}, SAM), world)).toEqual({
      failed: { actor_kind: "human" },
    });
  });
});
