import { describe, expect, it } from "vitest";
import { SAM, judge, onPr, prWorld } from "./support.js";

describe("opened_to_review", () => {
  it("a pull request ready for review moves its open ticket, as the author", () => {
    const opened = onPr("pr.opened", {}, SAM);
    expect(judge("opened_to_review", opened, prWorld({}, "active"))).toEqual([
      "act for sam: move ACME-9 to review",
    ]);

    expect(judge("opened_to_review", opened, prWorld({ draft: true }, "active"))).toEqual({
      failed: { not: { pr_draft: true } },
    });

    expect(judge("opened_to_review", opened, prWorld({}, "done"))).toEqual({
      failed: { ticket_status: ["backlog", "ready", "active"] },
    });
  });
});
