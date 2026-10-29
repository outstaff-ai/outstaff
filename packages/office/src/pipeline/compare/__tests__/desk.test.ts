import { describe, expect, it } from "vitest";
import { deskRecord } from "#/pipeline/compare/desk.js";

const subject = { type: "chat" as const, ref: "D-1" };
const result = (disposition: string, item?: { kind?: string }) =>
  ({
    disposition,
    repeated: false,
    links: [],
    work: [],
    ...(item ? { item: { id: "w-1", title: "t", status: "queued", ...item } } : {}),
  }) as Parameters<typeof deskRecord>[2];

const wake = (kind: string) => ({ type: "wake", person: "sam", kind, subject });

describe("deskRecord", () => {
  it("records a chat session the desk started, or holds for a free one, as a chat wake", () => {
    for (const d of ["started", "limited"]) {
      expect(deskRecord("sam", subject, result(d, { kind: "chat" }))).toEqual({
        effects: [wake("chat")],
      });
    }
  });

  it("records a message that joined an item of the thread as a wake of that item's kind", () => {
    expect(deskRecord("sam", subject, result("joined", { kind: "review_feedback" }))).toEqual({
      effects: [wake("review_feedback")],
    });

    expect(deskRecord("sam", subject, result("joined", {}))).toEqual({ effects: [wake("chat")] });
  });

  it("records a placement answer as no wake, saying what the desk did instead", () => {
    for (const d of ["placed", "asked_pm", "unclear"]) {
      const r = deskRecord("sam", subject, result(d));
      expect(r.effects).toEqual([]);
      expect(r.skipped).toMatchObject([
        { outcome: wake("chat"), note: expect.stringContaining("the desk") },
      ]);
    }
  });
});
