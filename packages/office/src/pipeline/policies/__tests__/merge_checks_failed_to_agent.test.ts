import { describe, expect, it } from "vitest";
import { OFFICE, judge, onPr, prWorld, HUMAN_AUTHOR, t, type World } from "./support.js";

describe("merge_checks_failed_to_agent", () => {
  const failed = onPr(
    "pr.merge_checks_failed",
    { sha: "abc1234", failing: [{ name: "deploy", url: "https://ci.acme.example/deploy" }] },
    OFFICE,
  );

  /** A human's merged pull request #9 on ACME-9, with the ticket as given. */
  const humans = (ticket: ReturnType<typeof t>): World => ({
    ...prWorld({ state: "merged", author: HUMAN_AUTHOR }),
    tickets: { "ACME-9": ticket },
  });

  it("wakes the author of an agent's merged pull request", () => {
    expect(judge("merge_checks_failed_to_agent", failed, prWorld({ state: "merged" }))).toEqual([
      "wake sam (merge_checks_failed) on pr acme-example/shop#9",
    ]);
  });

  it("wakes the ticket's agent for a human's pull request, else the agent who last worked on it", () => {
    expect(judge("merge_checks_failed_to_agent", failed, humans(t("review", "sam")))).toEqual([
      "wake sam (merge_checks_failed) on pr acme-example/shop#9",
    ]);

    expect(
      judge(
        "merge_checks_failed_to_agent",
        failed,
        humans(t("review", "ada-admin", { lastWorker: "sam" })),
      ),
    ).toEqual(["wake sam (merge_checks_failed) on pr acme-example/shop#9"]);
  });

  it("drops it with the reason when no agent holds the ticket or worked on it", () => {
    expect(judge("merge_checks_failed_to_agent", failed, humans(t("review", "ada-admin")))).toEqual(
      [
        "drop: no one to wake: pull request has no agent author; ticket is not assigned to an agent; no agent has worked on the ticket yet",
      ],
    );
  });

  it("leaves a canceled ticket alone", () => {
    expect(
      judge("merge_checks_failed_to_agent", failed, prWorld({ state: "merged" }, "canceled")),
    ).toMatchObject({ failed: { not: {} } });
  });
});
