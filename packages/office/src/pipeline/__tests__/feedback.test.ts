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
        from: "human",
        kind: "chat",
        body: "Can you look?",
        at: msg.at,
        url: "https://chat.example/m/1",
      },
    ]);

    expect(feedbackFor(event("chat.message"))).toEqual([
      { actor: "ada-admin", from: "human", kind: "chat", body: "", at: "2026-10-05T09:00:00.000Z" },
    ]);
  });

  it("carries reviews and comments, and nothing for other events", () => {
    expect(
      feedbackFor(event("ticket.commented", { data: { body: "Please add a test." } })),
    ).toEqual([
      { actor: "ada-admin", from: "human", kind: "ticket_comment", body: "Please add a test." },
    ]);

    expect(feedbackFor(event("ticket.assigned"))).toEqual([]);
  });

  it("says who gave it as the office's trust model sees them: a human, an agent or automation", () => {
    const by = (
      actor: { kind: "agent" | "automation"; id: string },
      type: Parameters<typeof event>[0],
    ) => feedbackFor(event(type, { actor, data: { body: "x" } }))[0]?.from;

    expect(by({ kind: "agent", id: "mira" }, "pr.review_submitted")).toBe("agent");
    expect(by({ kind: "automation", id: "ci[bot]" }, "pr.ci_failed")).toBe("automation");
  });

  it("carries what an agent handed back as blocked, and nothing for another hand-back", () => {
    const sam = { kind: "agent" as const, id: "sam" };
    const back = (status: string, summary?: string) =>
      event("agent.handed_back", { actor: sam, data: { status, summary } });

    expect(feedbackFor(back("blocked", "Stopped: no credentials."))).toEqual([
      {
        actor: "sam",
        from: "agent",
        kind: "blocked",
        body: "Stopped: no credentials.",
        at: "2026-10-05T09:00:00.000Z",
      },
    ]);

    expect(feedbackFor(back("done", "Opened #9."))).toEqual([]);
    expect(feedbackFor(back("blocked"))).toEqual([]);
  });
});
