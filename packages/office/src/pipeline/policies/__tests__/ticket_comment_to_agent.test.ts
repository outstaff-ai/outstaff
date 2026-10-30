import { describe, expect, it } from "vitest";
import { ADA, SAM, judge, t, event } from "./support.js";

describe("ticket_comment_to_agent", () => {
  it("a human's comment wakes the agent mentioned, else the assignee", () => {
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

    expect(judge("ticket_comment_to_agent", comment({ mentions: ["mira"] }), world)).toEqual([
      "wake mira (ticket_comment) on ticket ACME-1",
    ]);

    expect(
      judge("ticket_comment_to_agent", comment(), {
        tickets: { "ACME-1": t("review", "ada.admin") },
      }),
    ).toMatchObject({
      failed: { any: expect.any(Array) },
    });

    expect(judge("ticket_comment_to_agent", comment({}, SAM), world)).toEqual({
      failed: { actor_kind: "human" },
    });
  });
});
