import { describe, expect, it } from "vitest";
import { judge, onPr, prWorld, HUMAN_AUTHOR, pr } from "./support.js";

describe("merged_closes_ticket", () => {
  it("as the author, unless the merge was into another branch or another pull request is open", () => {
    const merged = onPr("pr.merged");
    expect(judge("merged_closes_ticket", merged, prWorld({ state: "merged" }))).toEqual([
      "act for sam: move ACME-9 to done",
    ]);

    expect(
      judge("merged_closes_ticket", merged, prWorld({ state: "merged", baseRef: "sam/acme-8" })),
    ).toEqual({
      failed: { pr_base_default: true },
    });

    const two = {
      ...prWorld({ state: "merged" }),
      prs: [pr(9, { state: "merged" }), pr(10)],
      links: { 9: "ACME-9", 10: "ACME-9" },
    };

    expect(judge("merged_closes_ticket", merged, two)).toEqual({
      failed: { not: { ticket_prs_open: true } },
    });

    expect(
      judge("merged_closes_ticket", merged, prWorld({ state: "merged", author: HUMAN_AUTHOR })),
    ).toEqual(["drop: no agent to act for: pull request has no agent author"]);
  });
});
