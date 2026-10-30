import { describe, expect, it } from "vitest";
import { judge, onPr, prWorld, HUMAN_AUTHOR } from "./support.js";

describe("review_to_author", () => {
  it("feedback on an agent's open pull request, but not a bare approval", () => {
    expect(
      judge(
        "review_to_author",
        onPr("pr.comment", { kind: "comment", body: "Rename it." }),
        prWorld(),
      ),
    ).toEqual(["wake sam (review_feedback) on pr acme-example/shop#9"]);

    const bare = onPr("pr.review_submitted", { state: "approved", body: "" });
    expect(judge("review_to_author", bare, prWorld())).toMatchObject({ failed: { not: {} } });
    expect(
      judge(
        "review_to_author",
        onPr("pr.comment", { body: "x" }),
        prWorld({ author: HUMAN_AUTHOR }),
      ),
    ).toEqual({
      failed: { pr_author_kind: "agent" },
    });
  });
});
