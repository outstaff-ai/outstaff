import { describe, expect, it } from "vitest";
import { SAM, HUMAN_AUTHOR, judge, onPr, prWorld, t, type World } from "./support.js";

/** A human's open pull request #9 on ACME-9, with the ticket as given. */
const humans = (ticket: ReturnType<typeof t>): World => ({
  ...prWorld({ author: HUMAN_AUTHOR }),
  tickets: { "ACME-9": ticket },
});

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

  it("a human's pull request moves the ticket as its agent: the assignee, else the last worker", () => {
    const opened = onPr("pr.opened");
    expect(judge("opened_to_review", opened, humans(t("active", "sam")))).toEqual([
      "act for sam: move ACME-9 to review",
    ]);

    expect(
      judge("opened_to_review", opened, humans(t("active", "ada-admin", { lastWorker: "sam" }))),
    ).toEqual(["act for sam: move ACME-9 to review"]);

    expect(judge("opened_to_review", opened, humans(t("active", "ada-admin")))).toEqual([
      "drop: no agent to act for: pull request has no agent author; ticket is not assigned to an agent; no agent has worked on the ticket yet",
    ]);
  });
});
