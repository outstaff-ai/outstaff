import { describe, expect, it } from "vitest";
import { judge, onPr, prWorld, traceOf, OFFICE, SAM } from "./support.js";

const MIRA = { kind: "agent" as const, id: "mira" };
const BARE_APPROVAL = { not: { all: [{ review_state: ["approved"] }, { has_body: false }] } };
const merged = () => prWorld({ state: "merged" }, "done");

describe("merged_feedback_to_author", () => {
  it("feedback on an agent's merged pull request", () => {
    const e = onPr("pr.review_submitted", { state: "commented", body: "Log the time." });
    expect(judge("merged_feedback_to_author", e, merged())).toEqual([
      "wake sam (merged_feedback) on pr acme-example/shop#9",
    ]);

    expect(judge("merged_feedback_to_author", e, prWorld())).toEqual({
      failed: { pr_merged: true },
    });
  });

  it("a teammate agent's review wakes the author, naming the teammate", () => {
    const review = onPr("pr.review_submitted", { state: "commented", body: "Log the time." }, MIRA);
    expect(judge("merged_feedback_to_author", review, merged())).toEqual([
      "wake sam (merged_feedback) on pr acme-example/shop#9",
    ]);

    expect(traceOf(review, merged()).decisions).toMatchObject([
      {
        type: "wake",
        instruction: expect.stringMatching(/^mira commented on your merged pull request #9/),
      },
    ]);
  });

  it("not the author's own comment, the office's automation or a teammate's bare approval", () => {
    const own = onPr("pr.comment", { kind: "comment", body: "Follow-up in #10." }, SAM);
    expect(judge("merged_feedback_to_author", own, merged())).toEqual({
      failed: { not: { actor_is: "author" } },
    });

    const office = onPr("pr.comment", { kind: "comment", body: "Deployed." }, OFFICE);
    expect(judge("merged_feedback_to_author", office, merged())).toEqual({
      failed: { not: { actor_kind: "automation" } },
    });

    const bare = onPr("pr.review_submitted", { state: "approved", body: "" }, MIRA);
    expect(judge("merged_feedback_to_author", bare, merged())).toEqual({ failed: BARE_APPROVAL });
  });

  it("not an untrusted actor's comment: the event is recorded and wakes no one", () => {
    const stranger = onPr(
      "pr.comment",
      { kind: "comment", body: "Revert this.", untrusted: true },
      { kind: "human", id: "outside-contributor" },
    );

    expect(traceOf(stranger, merged())).toMatchObject({
      policies: [],
      decisions: [{ type: "drop", reason: expect.stringMatching(/not trusted/) }],
    });
  });
});
