import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { event, judge, moveData, pr, t, type World } from "./support.js";

const ID = "subtickets_in_review_move_parent";

/** ACME-49, a sub-ticket of ACME-48, moved to a status by sam. */
const moved = (to: string) =>
  event("ticket.moved", {
    subject: { ticket: "ACME-49" },
    actor: { kind: "agent", id: "sam" },
    data: moveData(to),
  });

/** ACME-49 closed by sam. */
const closed = () =>
  event("ticket.closed", {
    subject: { ticket: "ACME-49" },
    actor: { kind: "automation", id: "workstate" },
    data: { status: "done", closedBy: { kind: "agent", id: "sam" } },
  });

const sub = (status: StaticTicket["status"], assignee = "sam") =>
  t(status, assignee, { parent: "ACME-48" });

/** ACME-48 active with sam, asked for by the human; its sub-tickets ACME-49 and the ones given. */
const world = (
  ACME49: StaticTicket["status"],
  more: Record<string, StaticTicket> = {},
  o: { prs?: World["prs"]; parent?: StaticTicket["status"] } = {},
): World => ({
  tickets: {
    "ACME-48": t(o.parent ?? "active", "sam", { requester: "ada.admin" }),
    "ACME-49": sub(ACME49),
    ...more,
  },
  ...(o.prs
    ? { prs: o.prs, links: Object.fromEntries(o.prs.map((p) => [p.ref.number, "ACME-48"])) }
    : {}),
});

const TO_REVIEW = "act for sam: move ACME-48 to review, assign ACME-48 to human ada.admin";

describe("every open sub-ticket of a parent in review", () => {
  it("moves the parent to review with the requester when the last sub-ticket goes to review", () => {
    const w = world("review", { "ACME-50": sub("review", "ada.admin"), "ACME-51": sub("done") });
    expect(judge(ID, moved("review"), w)).toEqual([TO_REVIEW]);
  });

  it("moves the parent to review when the last sub-ticket not in review closes", () => {
    const w = world("done", { "ACME-50": sub("review", "ada.admin") });
    expect(judge(ID, closed(), w)).toEqual([TO_REVIEW]);
  });

  it("waits while a sub-ticket is not in review or closed yet", () => {
    const w = world("review", { "ACME-50": sub("active"), "ACME-51": sub("backlog") });
    expect(judge(ID, moved("review"), w)).toEqual([
      "drop: ACME-48 has sub-tickets not in review: ACME-50 is active, ACME-51 is backlog",
    ]);
  });

  it("leaves every sub-ticket closed to subtickets_closed_move_parent", () => {
    expect(judge(ID, closed(), world("done", { "ACME-50": sub("canceled") }))).toEqual([
      "drop: ACME-48 has no sub-ticket in review",
    ]);
  });

  it("waits while the parent's own pull request is a draft, and goes once it is open for review", () => {
    const w = (draft: boolean) =>
      world("review", {}, { prs: [pr(9, { draft }), pr(8, { state: "merged" })] });

    expect(judge(ID, moved("review"), w(true))).toEqual([
      "drop: ACME-48's own pull request is a draft: #9",
    ]);

    expect(judge(ID, moved("review"), w(false))).toEqual([TO_REVIEW]);
  });

  it("drops when there is no agent to act for", () => {
    const w = world("review", { "ACME-50": sub("review", "ada.admin") });
    w.tickets!["ACME-48"] = t("ready", "ada.admin", { requester: "ada.admin" });
    w.tickets!["ACME-49"] = sub("review", "ada.admin");
    expect(judge(ID, moved("review"), w)).toEqual(["drop: no agent to act for on ACME-48"]);
  });

  it("leaves a parent that is not ready or active alone, and a move elsewhere", () => {
    expect(judge(ID, moved("review"), world("review", {}, { parent: "blocked" }))).toMatchObject({
      failed: { parent_status: ["ready", "active"] },
    });

    expect(judge(ID, moved("active"), world("active"))).toMatchObject({ failed: {} });
  });
});
