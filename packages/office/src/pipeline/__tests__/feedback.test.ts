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

  it("carries what an agent handed back as blocked, and nothing for another hand-back", () => {
    const sam = { kind: "agent" as const, id: "sam" };
    const back = (status: string, summary?: string) =>
      event("agent.handed_back", { actor: sam, data: { status, summary } });

    expect(feedbackFor(back("blocked", "Stopped: no credentials."))).toEqual([
      {
        actor: "sam",
        kind: "blocked",
        body: "Stopped: no credentials.",
        at: "2026-10-05T09:00:00.000Z",
      },
    ]);

    expect(feedbackFor(back("done", "Opened #9."))).toEqual([]);
    expect(feedbackFor(back("blocked"))).toEqual([]);
  });
});
