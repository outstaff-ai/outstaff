import type { StaticTicket } from "@outstaff/core";
import { runPolicy } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { policy as closeParent } from "#/pipeline/policies/subtickets_closed_close_parent.js";
import {
  BUILT_IN_POLICIES,
  event,
  evaluatePipeline,
  judge,
  OPTS,
  pr,
  stateOf,
  t,
  traceOf,
  type World,
} from "./support.js";

const ID = "subtickets_closed_close_parent";

/** ACME-49 closed by sam, the last open sub-ticket of ACME-48. */
const closed = (status: "done" | "canceled" = "done") =>
  event("ticket.closed", {
    subject: { ticket: "ACME-49" },
    actor: { kind: "automation", id: "workstate" },
    data: { status, closedBy: { kind: "agent", id: "sam" } },
  });

/** ACME-48 with the human in review, last worked by sam; ACME-47 and ACME-49 its sub-tickets. */
const world = (
  status: StaticTicket["status"] = "review",
  o: { prs?: World["prs"]; lastWorker?: string; assignee?: string } = {},
): World => ({
  tickets: {
    "ACME-48": t(status, o.assignee ?? "ada.admin", {
      requester: "ada.admin",
      lastWorker: o.lastWorker ?? "sam",
    }),
    "ACME-47": t("canceled", "noor", { parent: "ACME-48" }),
    "ACME-49": t("done", "noor", { parent: "ACME-48" }),
  },
  ...(o.prs
    ? { prs: o.prs, links: Object.fromEntries(o.prs.map((p) => [p.ref.number, "ACME-48"])) }
    : {}),
});

describe("the last sub-ticket of a parent in review or blocked closing", () => {
  it("closes the parent with no open pull request of its own, as the agent that last worked it, with a note", () => {
    expect(judge(ID, closed(), world())).toEqual([
      "act for sam: move ACME-48 to done, assign ACME-48 to agent sam",
    ]);

    const act = traceOf(closed(), world()).decisions.find((d) => d.policy === ID);
    expect(act).toMatchObject({
      note: "ACME-49 was the last open sub-ticket of ACME-48. Its closed sub-tickets: ACME-47, ACME-49.",
    });

    // Its own pull requests merged or closed count as nothing open.
    const finished = world("blocked", {
      prs: [pr(9, { state: "merged" }), pr(10, { state: "closed" })],
    });

    expect(judge(ID, closed("canceled"), finished)).toEqual([
      "act for sam: move ACME-48 to done, assign ACME-48 to agent sam",
    ]);
  });

  it("sends a parent with an open pull request of its own to review with the requester, not to done", () => {
    expect(judge(ID, closed(), world("blocked", { prs: [pr(9)] }))).toEqual([
      "act for sam: move ACME-48 to review",
    ]);

    expect(judge(ID, closed(), world("review", { prs: [pr(9)], assignee: "sam" }))).toEqual([
      "act for sam: assign ACME-48 to human ada.admin",
    ]);

    expect(judge(ID, closed(), world("review", { prs: [pr(9)] }))).toEqual([
      "drop: ACME-48 is in review with the requester already",
    ]);
  });

  it("leaves a canceled, done or active parent alone, and one with open sub-tickets", () => {
    for (const status of ["canceled", "done", "active"] as const) {
      expect(judge(ID, closed(), world(status))).toMatchObject({
        failed: { parent_status: ["review", "blocked"] },
      });
    }

    const w = world();
    w.tickets!["ACME-50"] = t("review", "sam", { parent: "ACME-48" });
    expect(judge(ID, closed(), w)).toEqual(["drop: ACME-48 still has open sub-tickets: ACME-50"]);
  });

  it("acts for the closed sub-ticket's agent when the parent's last worker is no agent, and drops with none", () => {
    const w = world("review", { lastWorker: "ada.admin" });
    expect(judge(ID, closed(), w)).toMatchObject([expect.stringMatching(/^act for noor: /)]);

    w.tickets!["ACME-49"] = t("done", undefined, { parent: "ACME-48" });
    expect(judge(ID, closed(), w)).toEqual(["drop: no agent to act for on ACME-48"]);
  });

  it("moves the parent to review only when no human is known to give it to, and posts no note when the team turns it off", () => {
    const { fallbackRequester: _none, ...noFallback } = OPTS;
    const w = world("blocked", { prs: [pr(9)], assignee: "sam" });
    w.tickets!["ACME-48"] = t("blocked", "sam");
    const trace = evaluatePipeline(closed(), stateOf(w), BUILT_IN_POLICIES, noFallback);
    expect(trace.decisions.filter((d) => d.policy === ID)).toEqual([
      {
        type: "act",
        policy: ID,
        as: "sam",
        ops: [{ op: "move", ticket: "ACME-48", to: "review" }],
        note: expect.any(String),
      },
    ]);

    const input = { event: closed(), state: stateOf(world()), options: OPTS };
    expect(runPolicy({ ...closeParent, instruction: "" }, input).proposals).toMatchObject([
      { type: "act", as: "sam" },
    ]);

    expect(runPolicy({ ...closeParent, instruction: "" }, input).proposals[0]).not.toHaveProperty(
      "note",
    );

    expect(runPolicy({ ...closeParent, instruction: "{{unknown}}" }, input).proposals).toEqual([
      { type: "drop", reason: expect.stringMatching(/^the note cannot be rendered: /) },
    ]);
  });
});
