import { describe, expect, it } from "vitest";
import { OFFICE, judge, onPr, prWorld, HUMAN_AUTHOR } from "./support.js";

describe("ci_failed_to_author", () => {
  it("failing checks on an agent's open pull request", () => {
    const e = onPr("pr.ci_failed", { checks: [{ name: "test" }] }, OFFICE);
    expect(judge("ci_failed_to_author", e, prWorld())).toEqual([
      "wake sam (ci_failed) on pr acme-example/shop#9",
    ]);

    expect(judge("ci_failed_to_author", e, prWorld({ author: HUMAN_AUTHOR }))).toEqual({
      failed: { pr_author_kind: "agent" },
    });
  });
});
