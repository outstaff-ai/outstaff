import { describe, expect, it } from "vitest";
import { feedbackFor } from "#/pipeline/feedback.js";
import { event } from "./support.js";

describe("feedbackFor", () => {
  it("carries a chat message as chat feedback", () => {
    const msg = event("chat.message", {
      data: { body: "Can you look?", url: "https://chat.example/m/1" },
    });

    expect(feedbackFor(msg)).toEqual([
      {
        actor: "ada-admin",
        kind: "chat",
        body: "Can you look?",
        at: msg.at,
        url: "https://chat.example/m/1",
      },
    ]);

    expect(feedbackFor(event("chat.message"))).toEqual([
      { actor: "ada-admin", kind: "chat", body: "", at: "2026-10-05T09:00:00.000Z" },
    ]);
  });

  it("carries reviews and comments, and nothing for other events", () => {
    expect(
      feedbackFor(event("ticket.commented", { data: { body: "Please add a test." } })),
    ).toEqual([{ actor: "ada-admin", kind: "ticket_comment", body: "Please add a test." }]);

    expect(feedbackFor(event("ticket.assigned"))).toEqual([]);
  });
});
