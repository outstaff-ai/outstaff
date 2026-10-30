import { describe, expect, it } from "vitest";
import { judge, event } from "./support.js";

describe("doc_comment_to_agent", () => {
  it("a human's comment wakes the agent mentioned, else the author", () => {
    const comment = (data: Record<string, unknown> = {}) =>
      event("doc.commented", {
        subject: { doc: "doc-7" },
        data: { title: "Order events", ...data },
      });

    const world = { docs: { "doc-7": "mira" } };
    expect(judge("doc_comment_to_agent", comment(), world)).toEqual([
      "wake mira (doc_feedback) on doc doc-7",
    ]);

    expect(judge("doc_comment_to_agent", comment({ mentions: ["leo"] }), world)).toEqual([
      "wake leo (doc_feedback) on doc doc-7",
    ]);
  });
});
