import { describe, expect, it } from "vitest";
import { OFFICE, judge, onPr, prWorld, HUMAN_AUTHOR, pr, t, type World } from "./support.js";

const merged = onPr("pr.merge_checks_passed", {}, OFFICE);

/** A human's merged pull request #9 on ACME-9, with the ticket as given. */
const humans = (ticket: ReturnType<typeof t>, more: Partial<World> = {}): World => ({
  ...prWorld({ state: "merged", author: HUMAN_AUTHOR }),
  tickets: { "ACME-9": ticket },
  ...more,
});

describe("merged_closes_ticket", () => {
  it("as the author, unless the merge was into another branch or another pull request is open", () => {
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
  });

  it("a human's pull request, as the agent the ticket is assigned to", () => {
    expect(judge("merged_closes_ticket", merged, humans(t("review", "sam")))).toEqual([
      "act for sam: move ACME-9 to done",
    ]);
  });

  it("a human's pull request, as the agent who last worked on the ticket, when no agent holds it", () => {
    const lastSam = { lastWorker: "sam" };
    expect(judge("merged_closes_ticket", merged, humans(t("review", undefined, lastSam)))).toEqual([
      "act for sam: move ACME-9 to done, assign ACME-9 to agent sam",
    ]);

    expect(
      judge("merged_closes_ticket", merged, humans(t("review", "ada-admin", lastSam))),
    ).toEqual(["act for sam: move ACME-9 to done, assign ACME-9 to agent sam"]);
  });

  it("drops a human's pull request on a ticket no agent holds or has worked on", () => {
    expect(judge("merged_closes_ticket", merged, humans(t("review", "ada-admin")))).toEqual([
      "drop: no agent to act for: pull request has no agent author; ticket is not assigned to an agent; no agent has worked on the ticket yet",
    ]);
  });

  it("leaves a parent open while one of its sub-tickets is", () => {
    const world = { ...prWorld({ state: "merged" }) };
    world.tickets = { ...world.tickets, "ACME-10": t("ready", "sam", { parent: "ACME-9" }) };
    expect(judge("merged_closes_ticket", merged, world)).toEqual({
      failed: { not: { open_subtickets: true } },
    });

    world.tickets["ACME-10"] = t("done", "sam", { parent: "ACME-9" });
    expect(judge("merged_closes_ticket", merged, world)).toEqual([
      "act for sam: move ACME-9 to done",
    ]);
  });

  it("leaves a human's ticket open while another of its pull requests is", () => {
    const two = humans(t("review", "sam"), {
      prs: [pr(9, { state: "merged", author: HUMAN_AUTHOR }), pr(10)],
      links: { 9: "ACME-9", 10: "ACME-9" },
    });

    expect(judge("merged_closes_ticket", merged, two)).toEqual({
      failed: { not: { ticket_prs_open: true } },
    });
  });
});
