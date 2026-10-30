import { describe, expect, it } from "vitest";
import { judge, onPr, prWorld } from "./support.js";

describe("merged_feedback_to_author", () => {
  it("feedback on an agent's merged pull request", () => {
    const e = onPr("pr.review_submitted", { state: "commented", body: "Log the time." });
    expect(judge("merged_feedback_to_author", e, prWorld({ state: "merged" }, "done"))).toEqual([
      "wake sam (merged_feedback) on pr acme-example/shop#9",
    ]);

    expect(judge("merged_feedback_to_author", e, prWorld())).toEqual({
      failed: { pr_merged: true },
    });
  });
});
